package douyin

// Live-room WebSocket danmaku/PK listener (抖音 Web 直播间 WebSocket 协议).
//
// The handshake query matches the browser handshake byte-for-byte apart from
// the random X-Bogus signature; room info and the im/fetch seed are recomputed
// on every (re)connect, and a fresh PK dedup handler is installed per socket.

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

const (
	liveWSHost = "webcast100-ws-web-hl.douyin.com"
	liveWSPath = "/webcast/im/push/v2/"

	liveHeartbeatInterval = 5 * time.Second
	liveEventBuffer       = 256
	liveStartFailures     = 3
	liveMaxBackoff        = 30 * time.Second
	// liveDedupLimit bounds the (method, msgId) replay cache; Douyin pushes
	// the same buffered message more than once around reconnects, which users
	// reported as duplicated gift/chat events (upstream issue #88).
	liveDedupLimit = 512
	// liveHealthyUptime is how long a socket must stay up before its drop is
	// treated as a fresh event rather than a flapping reconnect.
	liveHealthyUptime = 60 * time.Second
)

// LiveEvent is one decoded live-room push event.
//
// Kind is one of chat, gift, member, like, social, room_stats or pk. Data uses
// the protobuf field names of the protocol (gift's to_user and
// combo_count, the user's sec_uid/nickname, room stats' display_long, ...); pk
// events carry the normalised PK map from DecodePKMessage.
type LiveEvent struct {
	Kind string
	Data map[string]any
}

// LiveListener subscribes to one live room's WebSocket push stream.
type LiveListener struct {
	client *Client
	liveID string

	events chan LiveEvent
	stopCh chan struct{}
	// stop closes stopCh and the active socket exactly once; set by NewLiveListener.
	stop func()

	mu      sync.Mutex
	conn    *websocket.Conn
	started bool

	handlerMu sync.Mutex
	handler   *PKMessageHandler

	seenMu sync.Mutex
	seen   map[string]struct{}
	seenQ  []string
}

// NewLiveListener creates a listener for a live room number (or web_rid).
func NewLiveListener(c *Client, liveID string) *LiveListener {
	l := &LiveListener{
		client:  c,
		liveID:  liveID,
		events:  make(chan LiveEvent, liveEventBuffer),
		stopCh:  make(chan struct{}),
		handler: NewPKMessageHandler(),
		seen:    map[string]struct{}{},
	}
	l.stop = sync.OnceFunc(func() {
		close(l.stopCh)
		l.mu.Lock()
		conn := l.conn
		l.mu.Unlock()
		if conn != nil {
			_ = conn.Close()
		}
	})
	return l
}

// Events returns the decoded event stream. The channel is never closed;
// consumers should also select on Done() to learn when the listener stopped.
func (l *LiveListener) Events() <-chan LiveEvent { return l.events }

// Done is closed when Stop() is called.
func (l *LiveListener) Done() <-chan struct{} { return l.stopCh }

// Stop closes the active socket and unblocks Start. Safe to call repeatedly.
func (l *LiveListener) Stop() { l.stop() }

// Start runs the receive loop until ctx is cancelled or Stop is called. It
// blocks and reconnects after every close with exponential backoff capped at
// liveMaxBackoff. Repeated *setup* failures (room info / handshake) give up
// after liveStartFailures attempts; established sockets that drop keep
// reconnecting so unattended monitoring survives, with a growing backoff when
// the room keeps flapping.
func (l *LiveListener) Start(ctx context.Context) error {
	l.mu.Lock()
	if l.started {
		l.mu.Unlock()
		return fmt.Errorf("live listener already started")
	}
	l.started = true
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		l.started = false
		l.mu.Unlock()
	}()

	setupFailures := 0
	dropStreak := 0
	var firstErr error
	for {
		if l.done(ctx) {
			return nil
		}
		startedAt := time.Now()
		established, err := l.run(ctx)
		if l.done(ctx) {
			return nil
		}
		var delay time.Duration
		if established {
			setupFailures = 0
			// A socket that stayed up is healthy and resets the backoff; one
			// that keeps dropping is backed off so a flapping room cannot turn
			// into a permanent 1s reconnect storm (upstream PR #78).
			if time.Since(startedAt) >= liveHealthyUptime {
				dropStreak = 0
			} else {
				dropStreak++
			}
			delay = liveBackoff(dropStreak)
		} else {
			if setupFailures == 0 {
				firstErr = err
			}
			setupFailures++
			if setupFailures >= liveStartFailures {
				return firstErr
			}
			delay = liveBackoff(setupFailures)
		}
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return nil
		case <-l.stopCh:
			return nil
		}
	}
}

func (l *LiveListener) done(ctx context.Context) bool {
	if ctx.Err() != nil {
		return true
	}
	select {
	case <-l.stopCh:
		return true
	default:
		return false
	}
}

func liveBackoff(attempt int) time.Duration {
	delay := time.Second
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= liveMaxBackoff {
			return liveMaxBackoff
		}
	}
	return delay
}

// liveWSWriter serialises writes to one socket (gorilla allows a single
// concurrent writer).
type liveWSWriter struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (w *liveWSWriter) write(data []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.WriteMessage(websocket.BinaryMessage, data)
}

// run performs one connect/serve cycle. It reports whether the socket was
// established before it closed.
func (l *LiveListener) run(ctx context.Context) (bool, error) {
	roomInfo, err := l.client.GetLiveInfo(ctx, l.liveID)
	if err != nil {
		return false, err
	}
	roomID := liveString(roomInfo["room_id"])
	userID := liveString(roomInfo["user_id"])
	if roomID == "" || userID == "" {
		return false, fmt.Errorf("直播间信息缺少 room_id/user_id: %s", l.liveID)
	}
	pageURL := liveBase + "/" + l.liveID
	detail, err := l.client.GetWebcastDetail(ctx, userID, roomID, pageURL)
	if err != nil {
		return false, err
	}
	cursor, internalExt := "", ""
	if seed, err := ProtoUnmarshal("LiveResponse", detail); err == nil {
		cursor = ProtoFieldString(seed, "cursor")
		internalExt = ProtoFieldString(seed, "internalExt")
	}
	prof := GetProfile()
	query := l.wsQuery(cursor, internalExt, roomID, userID)

	header := http.Header{}
	header.Set("Cookie", l.client.CookieStr())
	header.Set("Origin", liveBase)
	header.Set("Pragma", "no-cache")
	header.Set("Cache-Control", "no-cache")
	header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6")
	header.Set("User-Agent", prof.UA)

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 30 * time.Second
	conn, _, err := dialer.DialContext(ctx, "wss://"+liveWSHost+liveWSPath+"?"+query, header)
	if err != nil {
		return false, fmt.Errorf("dial live websocket: %w", err)
	}
	l.setConn(conn)
	// A reconnect may have missed an entire battle or a channel change.
	l.resetHandler()

	writer := &liveWSWriter{conn: conn}
	hbCtx, cancelHB := context.WithCancel(ctx)
	defer cancelHB()
	go l.heartbeat(hbCtx, writer)

	watchDone := make(chan struct{})
	defer close(watchDone)
	go func() {
		select {
		case <-ctx.Done():
		case <-l.stopCh:
		case <-watchDone:
			return
		}
		_ = conn.Close()
	}()

	defer func() {
		l.setConn(nil)
		_ = conn.Close()
	}()
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return true, nil
		}
		l.handleFrame(writer, data)
	}
}

// wsQuery builds the WebSocket handshake query: the parameter order is the
// browser wire order and every value is urlencoded.
func (l *LiveListener) wsQuery(cursor, internalExt, roomID, userID string) string {
	prof := GetProfile()
	return liveFormEncode([][2]string{
		{"app_name", "douyin_web"},
		{"version_code", "180800"},
		{"webcast_sdk_version", "1.0.15"},
		{"update_version_code", "1.0.15"},
		{"compress", "gzip"},
		{"device_platform", "web"},
		{"cookie_enabled", "true"},
		{"screen_width", "1707"},
		{"screen_height", "960"},
		{"browser_language", "zh-CN"},
		{"browser_platform", "Win32"},
		{"browser_name", "Mozilla"},
		{"browser_version", strings.Replace(prof.UA, "Mozilla/", "", 1)},
		{"browser_online", "true"},
		{"tz_name", "Etc/GMT-8"},
		{"cursor", cursor},
		{"internal_ext", internalExt},
		{"host", liveBase},
		{"aid", "6383"},
		{"live_id", "1"},
		{"did_rule", "3"},
		{"endpoint", "live_pc"},
		{"support_wrds", "1"},
		{"user_unique_id", userID},
		{"im_path", "/webcast/im/fetch/"},
		{"identity", "audience"},
		{"need_persist_msg_count", "15"},
		{"insert_task_id", ""},
		{"live_reason", ""},
		{"room_id", roomID},
		{"heartbeatDuration", "0"},
		{"signature", l.client.XSigner.Signature(roomID, userID)},
	})
}

func (l *LiveListener) setConn(conn *websocket.Conn) {
	l.mu.Lock()
	l.conn = conn
	l.mu.Unlock()
}

func (l *LiveListener) resetHandler() {
	l.handlerMu.Lock()
	l.handler = NewPKMessageHandler()
	l.handlerMu.Unlock()
}

func (l *LiveListener) pkHandler() *PKMessageHandler {
	l.handlerMu.Lock()
	defer l.handlerMu.Unlock()
	return l.handler
}

// heartbeat sends an empty PushFrame with payloadType "hb" every 5 seconds,
// like the browser's ping.
func (l *LiveListener) heartbeat(ctx context.Context, writer *liveWSWriter) {
	frame, err := ProtoNew("PushFrame")
	if err != nil {
		return
	}
	if err := SetProtoField(frame, "payloadType", "hb"); err != nil {
		return
	}
	data, err := ProtoMarshal(frame)
	if err != nil {
		return
	}
	for {
		if err := writer.write(data); err != nil {
			_ = writer.conn.Close()
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-l.stopCh:
			return
		case <-time.After(liveHeartbeatInterval):
		}
	}
}

// handleFrame decodes one PushFrame: gzip payloads are inflated, acks are
// answered with the response's internalExt, and every message list item is
// dispatched. A malformed frame is dropped without killing the socket.
func (l *LiveListener) handleFrame(writer *liveWSWriter, data []byte) {
	frame, err := ProtoUnmarshal("PushFrame", data)
	if err != nil {
		return
	}
	payloadType := ProtoFieldString(frame, "payloadType")
	payload := liveProtoBytes(frame, "payload")
	if payloadType == "hb" || payloadType == "ack" || len(payload) == 0 {
		return
	}
	if bytes.HasPrefix(payload, []byte{0x1f, 0x8b}) {
		zr, err := gzip.NewReader(bytes.NewReader(payload))
		if err != nil {
			return
		}
		inflated, err := io.ReadAll(zr)
		_ = zr.Close()
		if err != nil {
			return
		}
		payload = inflated
	}
	response, err := ProtoUnmarshal("LiveResponse", payload)
	if err != nil {
		return
	}
	if liveProtoBool(response, "needAck") {
		if ack, err := ProtoNew("PushFrame"); err == nil {
			_ = SetProtoField(ack, "payloadType", "ack")
			_ = SetProtoField(ack, "payload", []byte(ProtoFieldString(response, "internalExt")))
			_ = SetProtoField(ack, "logId", int64(liveProtoUint64(frame, "logId")))
			if raw, err := ProtoMarshal(ack); err == nil {
				_ = writer.write(raw)
			}
		}
	}
	for _, item := range liveProtoMessages(response, "messagesList") {
		l.dispatch(item)
	}
}

// dispatch decodes one Message item into a LiveEvent.
func (l *LiveListener) dispatch(item proto.Message) {
	method := ProtoFieldString(item, "method")
	payload := liveProtoBytes(item, "payload")
	msgID := liveProtoInt64(item, "msgId")
	if l.duplicate(method, msgID) {
		return
	}
	if _, ok := pkProtoMessages[pkCanonical(method)]; ok {
		event, err := l.pkHandler().Handle(method, payload, msgID)
		if err != nil || event == nil {
			return
		}
		l.emit(LiveEvent{Kind: "pk", Data: event})
		return
	}
	var name, kind string
	switch method {
	case "WebcastGiftMessage":
		name, kind = "GiftMessage", "gift"
	case "WebcastChatMessage":
		name, kind = "ChatMessage", "chat"
	case "WebcastMemberMessage":
		name, kind = "MemberMessage", "member"
	case "WebcastLikeMessage":
		name, kind = "LikeMessage", "like"
	case "WebcastSocialMessage":
		name, kind = "SocialMessage", "social"
	case "WebcastRoomStatsMessage":
		name, kind = "RoomStatsMessage", "room_stats"
	default:
		return
	}
	message, err := ProtoUnmarshal(name, payload)
	if err != nil {
		return
	}
	decoded, err := ProtoToMap(message)
	if err != nil {
		return
	}
	l.emit(LiveEvent{Kind: kind, Data: decoded})
}

// duplicate reports whether (method, msgId) was already delivered. Messages
// without a msgId are never deduplicated.
func (l *LiveListener) duplicate(method string, msgID int64) bool {
	if msgID == 0 {
		return false
	}
	key := method + ":" + strconv.FormatInt(msgID, 10)
	l.seenMu.Lock()
	defer l.seenMu.Unlock()
	if _, ok := l.seen[key]; ok {
		return true
	}
	l.seen[key] = struct{}{}
	l.seenQ = append(l.seenQ, key)
	if len(l.seenQ) > liveDedupLimit {
		oldest := l.seenQ[0]
		l.seenQ = l.seenQ[1:]
		delete(l.seen, oldest)
	}
	return false
}

func (l *LiveListener) emit(event LiveEvent) {
	select {
	case l.events <- event:
	case <-l.stopCh:
	}
}

func liveProtoFieldDesc(msg proto.Message, name string) protoreflect.FieldDescriptor {
	if msg == nil {
		return nil
	}
	return msg.ProtoReflect().Descriptor().Fields().ByName(protoreflect.Name(name))
}

// liveProtoBytes reads a bytes field from a dynamic protocol message.
func liveProtoBytes(msg proto.Message, name string) []byte {
	fd := liveProtoFieldDesc(msg, name)
	if fd == nil || fd.IsList() {
		return nil
	}
	value := msg.ProtoReflect().Get(fd)
	if fd.Kind() != protoreflect.BytesKind {
		return nil
	}
	return value.Bytes()
}

// liveProtoInt64 reads an integer field (any width) from a dynamic message.
func liveProtoInt64(msg proto.Message, name string) int64 {
	fd := liveProtoFieldDesc(msg, name)
	if fd == nil || fd.IsList() {
		return 0
	}
	value := msg.ProtoReflect().Get(fd)
	switch fd.Kind() {
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind,
		protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		return value.Int()
	case protoreflect.Uint32Kind, protoreflect.Fixed32Kind,
		protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		return int64(value.Uint())
	}
	return 0
}

// liveProtoUint64 reads an unsigned integer field from a dynamic message.
func liveProtoUint64(msg proto.Message, name string) uint64 {
	fd := liveProtoFieldDesc(msg, name)
	if fd == nil || fd.IsList() {
		return 0
	}
	value := msg.ProtoReflect().Get(fd)
	switch fd.Kind() {
	case protoreflect.Uint32Kind, protoreflect.Fixed32Kind,
		protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		return value.Uint()
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind,
		protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		return uint64(value.Int())
	}
	return 0
}

// liveProtoBool reads a bool field from a dynamic message.
func liveProtoBool(msg proto.Message, name string) bool {
	fd := liveProtoFieldDesc(msg, name)
	if fd == nil || fd.IsList() {
		return false
	}
	return msg.ProtoReflect().Get(fd).Bool()
}

// liveProtoMessages reads a repeated message field from a dynamic message.
func liveProtoMessages(msg proto.Message, name string) []proto.Message {
	fd := liveProtoFieldDesc(msg, name)
	if fd == nil || !fd.IsList() || fd.Kind() != protoreflect.MessageKind {
		return nil
	}
	list := msg.ProtoReflect().Get(fd).List()
	out := make([]proto.Message, 0, list.Len())
	for i := range list.Len() {
		out = append(out, list.Get(i).Message().Interface())
	}
	return out
}
