package douyin

// PK (双人连线对战) WebSocket message decoding and per-connection context
// tracking.
//
// Armies pushes are partial ranking snapshots, not the HTTP full contribution
// list. They carry no battle id: context_battle_id is only an inference from a
// live, time-compatible lifecycle/score event, never a confirmed id.

import (
	"cmp"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// pkProtoMessages maps the canonical (Webcast prefix stripped) PK method names
// to their protobuf message names.
var pkProtoMessages = map[string]string{
	"LinkMicMethod":             "douyin.pk.LinkMicMethod",
	"LinkMicArmiesMethod":       "douyin.pk.LinkMicArmies",
	"LinkMicBattleMethod":       "douyin.pk.LinkMicBattle",
	"LinkMicBattleFinishMethod": "douyin.pk.LinkMicBattleFinish",
}

// pkCanonical strips the Webcast prefix so both spellings of a PK method
// deduplicate against each other.
func pkCanonical(method string) string { return strings.TrimPrefix(method, "Webcast") }

// pkNum reads a protojson number (int64 fields arrive as strings) as int64.
func pkNum(v any) int64 {
	switch t := v.(type) {
	case nil:
		return 0
	case string:
		if t == "" {
			return 0
		}
		n, err := strconv.ParseInt(t, 10, 64)
		if err != nil {
			return 0
		}
		return n
	case float64:
		return int64(t)
	case int64:
		return t
	case int:
		return int64(t)
	case bool:
		if t {
			return 1
		}
		return 0
	case json.Number:
		if n, err := t.Int64(); err == nil {
			return n
		}
		if f, err := t.Float64(); err == nil {
			return int64(f)
		}
		return 0
	}
	return 0
}

// pkText reads a string field, defaulting to "".
func pkText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// pkID ports _id(number, explicit=”): an explicit "<field>_str" always wins,
// otherwise the number is stringified, and zero/absent becomes nil.
func pkID(number int64, explicit string) any {
	if explicit != "" {
		return explicit
	}
	if number != 0 {
		return strconv.FormatInt(number, 10)
	}
	return nil
}

// pkTimeMS ports _time_ms(): create_time has appeared in both seconds and
// milliseconds.
func pkTimeMS(value int64) int64 {
	if value > 0 && value < 100_000_000_000 {
		return value * 1000
	}
	return value
}

// pkRanks ports _ranks(): a 1-based partial contribution snapshot.
func pkRanks(users []any) []any {
	out := make([]any, 0, len(users))
	for i, item := range users {
		u := liveObj(item)
		out = append(out, map[string]any{
			"rank":     i + 1,
			"uid":      pkID(pkNum(u["user_id"]), pkText(u["user_id_str"])),
			"nickname": pkText(u["nickname"]),
			"score":    strconv.FormatInt(pkNum(u["score"]), 10),
		})
	}
	return out
}

// pkScores ports _scores(): both sides' PK scores.
func pkScores(users []any) []any {
	out := make([]any, 0, len(users))
	for _, item := range users {
		u := liveObj(item)
		out = append(out, map[string]any{
			"anchor_id":           pkID(pkNum(u["user_id"]), pkText(u["user_id_str"])),
			"score":               strconv.FormatInt(pkNum(u["score"]), 10),
			"score_blur_text":     pkText(u["score_blur_text"]),
			"score_relative_text": pkText(u["score_relative_text"]),
			"battle_rank":         pkNum(u["battle_rank"]),
		})
	}
	return out
}

// pkArmyAnchors ports the armies map: anchors sorted by their numeric map key,
// each with its partial top contributors.
func pkArmyAnchors(raw any) []any {
	obj := liveObj(raw)
	keys := make([]int64, 0, len(obj))
	for key := range obj {
		n, err := strconv.ParseInt(key, 10, 64)
		if err != nil {
			continue
		}
		keys = append(keys, n)
	}
	slices.Sort(keys)
	out := make([]any, 0, len(keys))
	for _, key := range keys {
		army := liveObj(obj[strconv.FormatInt(key, 10)])
		out = append(out, map[string]any{
			"anchor_id": strconv.FormatInt(key, 10),
			"users":     pkRanks(liveArr(army["user_armies"])),
		})
	}
	return out
}

// DecodePKMessage normalises one PK payload into the event map shared by the
// PK event handlers, or returns (nil, nil) for a non-PK / other LinkMic event.
// All exposed 64-bit ids and scores are strings. A decode failure is returned
// as an error so a bad item cannot discard later items.
func DecodePKMessage(method string, payload []byte, msgID int64) (map[string]any, error) {
	canonical := pkCanonical(method)
	name, ok := pkProtoMessages[canonical]
	if !ok {
		return nil, nil
	}
	msg, err := ProtoUnmarshal(name, payload)
	if err != nil {
		return nil, err
	}
	raw, err := ProtoToMap(msg)
	if err != nil {
		return nil, err
	}
	common := liveObj(raw["common"])
	eventID := msgID
	if eventID == 0 {
		eventID = pkNum(common["msg_id"])
	}
	event := map[string]any{
		"method":             method,
		"msg_id":             pkID(eventID, ""),
		"room_id":            pkID(pkNum(common["room_id"]), ""),
		"create_time_ms":     pkTimeMS(pkNum(common["create_time"])),
		"battle_id":          nil,
		"channel_id":         nil,
		"context_battle_id":  nil,
		"context_channel_id": nil,
	}
	switch canonical {
	case "LinkMicMethod":
		if pkNum(raw["message_type"]) != 202 {
			return nil, nil
		}
		event["type"] = "scores"
		event["battle_id"] = pkID(pkNum(raw["battle_id"]), pkText(raw["battle_id_str"]))
		event["channel_id"] = pkID(pkNum(raw["channel_id"]), "")
		event["scores"] = pkScores(liveArr(raw["user_scores"]))
		return event, nil
	case "LinkMicArmiesMethod":
		event["type"] = "armies"
		event["is_complete"] = false
		event["anchors"] = pkArmyAnchors(raw["user_armies_map"])
		unassigned := []any{}
		for _, army := range liveArr(raw["user_armies_list"]) {
			unassigned = append(unassigned, pkRanks(liveArr(liveObj(army)["user_armies"])))
		}
		event["unassigned_armies"] = unassigned
		event["has_unsupported_rank_list_v2"] = pkText(raw["rank_list_v2"]) != ""
		return event, nil
	}
	settings := liveObj(raw["battle_settings"])
	battleStatus := pkNum(settings["battle_status"])
	event["battle_id"] = pkID(pkNum(settings["battle_id"]), pkText(settings["battle_id_str"]))
	event["channel_id"] = pkID(pkNum(settings["channel_id"]), pkText(settings["channel_id_str"]))
	event["start_time_ms"] = pkNum(settings["start_time_ms"])
	event["duration"] = pkNum(settings["duration"])
	event["battle_status"] = battleStatus
	if canonical == "LinkMicBattleFinishMethod" {
		event["type"] = "finish"
		event["is_complete"] = false
		event["end_reason"] = pkNum(raw["end_reason"])
		event["scores"] = pkScores(liveArr(raw["battle_scores"]))
		anchors := []any{}
		for _, army := range liveArr(raw["battle_armies"]) {
			a := liveObj(army)
			anchors = append(anchors, map[string]any{
				"anchor_id": pkID(pkNum(a["anchor_id"]), pkText(a["anchor_id_str"])),
				"users":     pkRanks(liveArr(a["rank_list"])),
			})
		}
		event["anchors"] = anchors
		return event, nil
	}
	if battleStatus == 1 {
		event["type"] = "start"
	} else {
		event["type"] = "status"
	}
	return event, nil
}

// pkKeyCache is a bounded LRU key set (recently used keys move to the end).
type pkKeyCache struct {
	limit int
	keys  []string
	index map[string]int
}

func newPKKeyCache(limit int) *pkKeyCache {
	return &pkKeyCache{limit: limit, index: map[string]int{}}
}

// remember records key and reports whether it was already present.
func (c *pkKeyCache) remember(key string) bool {
	if at, ok := c.index[key]; ok {
		copy(c.keys[at:], c.keys[at+1:])
		c.keys[len(c.keys)-1] = key
		for i := at; i < len(c.keys); i++ {
			c.index[c.keys[i]] = i
		}
		return true
	}
	c.index[key] = len(c.keys)
	c.keys = append(c.keys, key)
	if len(c.keys) > c.limit {
		delete(c.index, c.keys[0])
		c.keys = append(c.keys[:0], c.keys[1:]...)
		for i := range c.keys {
			c.index[c.keys[i]] = i
		}
	}
	return false
}

func (c *pkKeyCache) has(key string) bool {
	_, ok := c.index[key]
	return ok
}

// PKMessageHandler is bounded deduplication and conservative context for a
// single connection.
type PKMessageHandler struct {
	active   map[string]any
	seen     *pkKeyCache
	finished *pkKeyCache
}

// NewPKMessageHandler creates a handler for one WebSocket connection.
func NewPKMessageHandler() *PKMessageHandler {
	return &PKMessageHandler{seen: newPKKeyCache(512), finished: newPKKeyCache(128)}
}

// Active returns the battle the handler currently believes is on air, or nil.
func (h *PKMessageHandler) Active() map[string]any {
	if h.active == nil {
		return nil
	}
	out := make(map[string]any, len(h.active))
	for k, v := range h.active {
		out[k] = v
	}
	return out
}

// Handle decodes, deduplicates and annotates one PK message. It returns
// (nil, nil) for non-PK messages, duplicates and stale pushes.
func (h *PKMessageHandler) Handle(method string, payload []byte, msgID int64) (map[string]any, error) {
	event, err := DecodePKMessage(method, payload, msgID)
	if err != nil || event == nil {
		return nil, err
	}
	canonical := pkCanonical(method)
	if id := pkText(event["msg_id"]); id != "" {
		if h.seen.remember(canonical + "\x00" + id) {
			return nil, nil
		}
	}
	kind := pkText(event["type"])
	battleID := pkText(event["battle_id"])
	activeBattle := ""
	if h.active != nil {
		activeBattle = pkText(h.active["battle_id"])
	}
	switch {
	case kind == "finish":
		if battleID != "" && h.seen.remember("finish\x00"+pkFinishKey(event)) {
			return nil, nil
		}
		if battleID != "" {
			h.finished.remember(battleID)
		}
		if battleID != "" && battleID == activeBattle {
			h.active = nil
		}
	case (kind == "start" || kind == "scores") && battleID != "" && !h.finished.has(battleID):
		since := pkNum(event["start_time_ms"])
		if since == 0 {
			since = pkNum(event["create_time_ms"])
		}
		// Delayed messages for an older battle must not replace the current one.
		if h.active != nil && battleID == activeBattle {
			if channel := pkText(event["channel_id"]); channel != "" {
				h.active["channel_id"] = channel
			}
		} else if h.active == nil || (since != 0 && since >= pkNum(h.active["since"])) {
			h.active = map[string]any{
				"battle_id":  battleID,
				"channel_id": event["channel_id"],
				"since":      since,
			}
		}
	case kind == "status" && h.active != nil && battleID == activeBattle:
		if status := pkNum(event["battle_status"]); status == 2 || status == 3 {
			h.active = nil
		}
	case kind == "armies" && h.active != nil:
		since := pkNum(h.active["since"])
		created := pkNum(event["create_time_ms"])
		if since != 0 && created != 0 && created >= since {
			event["context_battle_id"] = h.active["battle_id"]
			event["context_channel_id"] = h.active["channel_id"]
		}
	}
	return event, nil
}

// pkFinishKey canonicalises a finish event so repeated deliveries with
// different message ids (and reversed anchor arrays) deduplicate.
func pkFinishKey(event map[string]any) string {
	var sb strings.Builder
	sb.WriteString(pkText(event["battle_id"]))
	sb.WriteByte('|')
	scores := slices.Clone(liveArr(event["scores"]))
	slices.SortStableFunc(scores, func(a, b any) int {
		return cmp.Compare(pkText(liveObj(a)["anchor_id"]), pkText(liveObj(b)["anchor_id"]))
	})
	for _, score := range scores {
		s := liveObj(score)
		fmt.Fprintf(&sb, "%v/%v/%v/%v/%v;", s["anchor_id"], s["score"],
			s["score_blur_text"], s["score_relative_text"], s["battle_rank"])
	}
	sb.WriteByte('|')
	anchors := slices.Clone(liveArr(event["anchors"]))
	slices.SortStableFunc(anchors, func(a, b any) int {
		return cmp.Compare(pkText(liveObj(a)["anchor_id"]), pkText(liveObj(b)["anchor_id"]))
	})
	for _, anchor := range anchors {
		a := liveObj(anchor)
		fmt.Fprintf(&sb, "%v:", a["anchor_id"])
		for _, user := range liveArr(a["users"]) {
			u := liveObj(user)
			fmt.Fprintf(&sb, "%v/%v/%v/%v;", u["rank"], u["uid"], u["nickname"], u["score"])
		}
		sb.WriteByte(',')
	}
	fmt.Fprintf(&sb, "|%v", event["end_reason"])
	return sb.String()
}
