package douyin

// Dynamic protobuf support for the live WebSocket and IM protocols. The
// .proto schemas are compiled at startup with protocompile (no protoc/codegen
// toolchain required).

import (
	"context"
	"embed"
	"fmt"
	"io"
	"sync"

	"github.com/bufbuild/protocompile"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/dynamicpb"
)

//go:embed proto/Live.proto proto/PK.proto proto/Request.proto proto/Response.proto
var protoFS embed.FS

// protoDescriptors compiles the embedded .proto files once on first use.
var protoDescriptors = sync.OnceValues(func() (map[protoreflect.FullName]protoreflect.MessageDescriptor, error) {
	resolver := protocompile.WithStandardImports(&protocompile.SourceResolver{
		Accessor: func(path string) (io.ReadCloser, error) {
			return protoFS.Open("proto/" + path)
		},
	})
	compiler := protocompile.Compiler{Resolver: resolver}
	files, err := compiler.Compile(context.Background(),
		"Live.proto", "PK.proto", "Request.proto", "Response.proto")
	if err != nil {
		return nil, err
	}
	msgs := map[protoreflect.FullName]protoreflect.MessageDescriptor{}
	for _, f := range files {
		collectMessages(f.Messages(), msgs)
	}
	return msgs, nil
})

func collectMessages(list protoreflect.MessageDescriptors, out map[protoreflect.FullName]protoreflect.MessageDescriptor) {
	for i := range list.Len() {
		md := list.Get(i)
		out[md.FullName()] = md
		collectMessages(md.Messages(), out)
	}
}

func protoDescriptor(name string) (protoreflect.MessageDescriptor, error) {
	msgs, err := protoDescriptors()
	if err != nil {
		return nil, err
	}
	if md, ok := msgs[protoreflect.FullName(name)]; ok {
		return md, nil
	}
	return nil, fmt.Errorf("proto message not found: %s", name)
}

// ProtoUnmarshal decodes data into a dynamic message of the named type.
func ProtoUnmarshal(name string, data []byte) (*dynamicpb.Message, error) {
	md, err := protoDescriptor(name)
	if err != nil {
		return nil, err
	}
	msg := dynamicpb.NewMessage(md)
	if err := proto.Unmarshal(data, msg); err != nil {
		return nil, err
	}
	return msg, nil
}

// ProtoNew creates an empty dynamic message of the named type.
func ProtoNew(name string) (*dynamicpb.Message, error) {
	md, err := protoDescriptor(name)
	if err != nil {
		return nil, err
	}
	return dynamicpb.NewMessage(md), nil
}

// ProtoMarshal serializes a dynamic message.
func ProtoMarshal(msg proto.Message) ([]byte, error) { return proto.Marshal(msg) }

// ProtoToMap converts a message to a JSON-shaped map.
func ProtoToMap(msg proto.Message) (map[string]any, error) {
	raw, err := protojson.MarshalOptions{UseProtoNames: true, EmitUnpopulated: false}.Marshal(msg)
	if err != nil {
		return nil, err
	}
	return decodeJSONObject(raw)
}

// ProtoFieldString returns a string field value from a dynamic message.
func ProtoFieldString(msg proto.Message, name string) string {
	fd := msg.ProtoReflect().Descriptor().Fields().ByName(protoreflect.Name(name))
	if fd == nil {
		return ""
	}
	return fmt.Sprintf("%v", msg.ProtoReflect().Get(fd).Interface())
}

// SetProtoField sets a field on a dynamic message (best-effort helper).
func SetProtoField(msg *dynamicpb.Message, name string, value any) error {
	fd := msg.Descriptor().Fields().ByName(protoreflect.Name(name))
	if fd == nil {
		return fmt.Errorf("field not found: %s", name)
	}
	switch {
	case fd.IsList():
		list := msg.Mutable(fd).List()
		switch v := value.(type) {
		case []string:
			for _, s := range v {
				list.Append(protoreflect.ValueOfString(s))
			}
		case []int64:
			for _, n := range v {
				list.Append(protoreflect.ValueOfInt64(n))
			}
		default:
			return fmt.Errorf("unsupported list value for %s", name)
		}
		return nil
	}
	switch fd.Kind() {
	case protoreflect.StringKind:
		msg.Set(fd, protoreflect.ValueOfString(fmt.Sprintf("%v", value)))
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		msg.Set(fd, protoreflect.ValueOfInt64(toInt64(value)))
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind:
		msg.Set(fd, protoreflect.ValueOfInt32(int32(toInt64(value))))
	case protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		msg.Set(fd, protoreflect.ValueOfUint64(uint64(toInt64(value))))
	case protoreflect.Uint32Kind, protoreflect.Fixed32Kind:
		msg.Set(fd, protoreflect.ValueOfUint32(uint32(toInt64(value))))
	case protoreflect.BoolKind:
		b, _ := value.(bool)
		msg.Set(fd, protoreflect.ValueOfBool(b))
	case protoreflect.BytesKind:
		b, _ := value.([]byte)
		msg.Set(fd, protoreflect.ValueOfBytes(b))
	default:
		return fmt.Errorf("unsupported field kind for %s", name)
	}
	return nil
}
