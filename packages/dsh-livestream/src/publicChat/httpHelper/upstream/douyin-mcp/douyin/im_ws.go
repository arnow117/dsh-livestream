package douyin

// WebSocket private-message receiver (PC IM 私信 push stream).

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/reflect/protoreflect"
)

const (
	imAppKey       = "e1bd35ec9db7b8d846de66ed140b1ad9"
	imFpID         = "9"
	imWSURL        = "wss://frontier-im.douyin.com/ws/v2"
	imWSSalt       = "f8a69f1719916z"
	imBackoffStart = 1.0
	imBackoffMax   = 30.0
)

// IMMessage is one decoded new-message notification.
type IMMessage struct {
	MessageIndex int64
	// ConversationID is "0:1:<a>:<b>" for a 1:1 chat and a bare numeric id for
	// a group chat.
	ConversationID string
	// ConversationType distinguishes 1:1 (1) from group chats (2).
	ConversationType int32
	// NotifyType is the push kind from NewMessageNotify (e.g. 50001 = read).
	NotifyType  int32
	Sender      int64
	MessageType int32
	Content     map[string]any
}

// IMReceiver maintains the frontier-im WebSocket and emits IMMessages.
type IMReceiver struct {
	c    *Client
	url  string
	ch   chan IMMessage
	stop chan struct{}

	// stopFunc closes stop exactly once; NewIMReceiver wires it (initStop).
	stopFunc func()
	mu       sync.Mutex
	conn     *websocket.Conn
}

// initStop wires the once-guarded close of the stop channel.
func (r *IMReceiver) initStop() {
	r.stopFunc = sync.OnceFunc(func() { close(r.stop) })
}

// NewIMReceiver builds the receiver for a client session.
func NewIMReceiver(c *Client) (*IMReceiver, error) {
	if c == nil {
		return nil, fmt.Errorf("NewIMReceiver: nil client")
	}
	deviceID := c.WebID(context.Background())
	accessKey := MD5Hex(imFpID + imAppKey + deviceID + imWSSalt)

	p := NewParams()
	p.Add("aid", "6383")
	p.Add("device_platform", "douyin_pc")
	p.Add("fpid", imFpID)
	p.Add("device_id", deviceID)
	p.Add("token", c.Cookie.Get("sessionid"))
	p.Add("access_key", accessKey)

	r := &IMReceiver{
		c:    c,
		url:  imWSURL + "?" + p.ToString(),
		ch:   make(chan IMMessage, 64),
		stop: make(chan struct{}),
	}
	r.initStop()
	return r, nil
}

// Events returns the decoded-message stream.
func (r *IMReceiver) Events() <-chan IMMessage { return r.ch }

// Stop closes the connection and lets Start return. Safe to call repeatedly.
func (r *IMReceiver) Stop() {
	r.stopFunc()
	r.mu.Lock()
	conn := r.conn
	r.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

func (r *IMReceiver) stopped() bool {
	select {
	case <-r.stop:
		return true
	default:
		return false
	}
}

// Start blocks, reconnecting with bounded exponential backoff (1s..30s,
// resetting after a successful open) until Stop or ctx cancellation.
func (r *IMReceiver) Start(ctx context.Context) error {
	backoff := imBackoffStart
	for {
		if r.stopped() {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		opened, _ := r.runOnce(ctx)
		if r.stopped() {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if opened {
			backoff = imBackoffStart
		}
		timer := time.NewTimer(time.Duration(backoff * float64(time.Second)))
		select {
		case <-r.stop:
			timer.Stop()
			return nil
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		backoff = min(backoff*2, imBackoffMax)
	}
}

func (r *IMReceiver) runOnce(ctx context.Context) (bool, error) {
	dialer := websocket.Dialer{
		HandshakeTimeout:  15 * time.Second,
		EnableCompression: true,
		Subprotocols:      []string{"binary", "base64", "pbbp2"},
	}
	header := http.Header{}
	header.Set("Pragma", "no-cache")
	header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6")
	header.Set("User-Agent", GetProfile().UA)
	header.Set("Cache-Control", "no-cache")
	header.Set("Cookie", r.c.CookieStr())

	conn, _, err := dialer.DialContext(ctx, r.url, header)
	if err != nil {
		return false, err
	}
	r.mu.Lock()
	r.conn = conn
	r.mu.Unlock()
	defer func() {
		_ = conn.Close()
		r.mu.Lock()
		if r.conn == conn {
			r.conn = nil
		}
		r.mu.Unlock()
	}()

	for {
		if r.stopped() {
			return true, nil
		}
		_, data, err := conn.ReadMessage()
		if err != nil {
			return true, err
		}
		r.handleFrame(data)
	}
}

func (r *IMReceiver) handleFrame(data []byte) {
	frame, err := ProtoUnmarshal("PushFrame", data)
	if err != nil {
		return
	}
	fm := frame.ProtoReflect()
	if protoGetString(fm, "payloadType") != "pb" {
		return
	}
	payloadFD := fm.Descriptor().Fields().ByName("payload")
	if payloadFD == nil {
		return
	}
	payload := fm.Get(payloadFD).Bytes()
	resp, err := ProtoUnmarshal("Response", payload)
	if err != nil {
		return
	}
	body, ok := protoSub(resp.ProtoReflect(), "body")
	if !ok {
		return
	}
	notify, ok := protoSub(body, "new_message_notify")
	if !ok {
		return
	}
	message, ok := protoSub(notify, "message")
	if !ok {
		return
	}
	contentRaw := protoGetString(message, "content")
	var content map[string]any
	if contentRaw != "" {
		_ = json.Unmarshal([]byte(contentRaw), &content)
	}
	convType := int32(protoGetInt64(notify, "conversation_type"))
	if convType == 0 {
		convType = int32(protoGetInt64(message, "conversation_type"))
	}
	msg := IMMessage{
		MessageIndex:     protoGetInt64(message, "index_in_conversation"),
		ConversationID:   protoGetString(message, "conversation_id"),
		ConversationType: convType,
		NotifyType:       int32(protoGetInt64(notify, "notify_type")),
		Sender:           protoGetInt64(message, "sender"),
		MessageType:      int32(protoGetInt64(message, "message_type")),
		Content:          content,
	}
	select {
	case r.ch <- msg:
	case <-r.stop:
	}
}

func protoSub(m protoreflect.Message, name string) (protoreflect.Message, bool) {
	if m == nil {
		return nil, false
	}
	fd := m.Descriptor().Fields().ByName(protoreflect.Name(name))
	if fd == nil || (fd.Kind() != protoreflect.MessageKind && fd.Kind() != protoreflect.GroupKind) {
		return nil, false
	}
	if !m.Has(fd) {
		return nil, false
	}
	return m.Get(fd).Message(), true
}

func protoGetString(m protoreflect.Message, name string) string {
	fd := m.Descriptor().Fields().ByName(protoreflect.Name(name))
	if fd == nil {
		return ""
	}
	return m.Get(fd).String()
}

func protoGetInt64(m protoreflect.Message, name string) int64 {
	fd := m.Descriptor().Fields().ByName(protoreflect.Name(name))
	if fd == nil {
		return 0
	}
	return m.Get(fd).Int()
}
