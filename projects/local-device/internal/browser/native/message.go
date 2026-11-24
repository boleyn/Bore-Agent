// Package native handles Chromium Native Messaging framing.
package native

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
)

const maxMessageBytes = 1024 * 1024

var errInvalidMessage = errors.New("invalid_native_browser_message")

// ReadMessage reads one native-endian length-prefixed JSON message. The size
// limit applies before allocation and is shared by both directions.
func ReadMessage(source io.Reader) (json.RawMessage, error) {
	var length uint32
	if err := binary.Read(source, binary.NativeEndian, &length); err != nil {
		return nil, err
	}
	if length == 0 || length > maxMessageBytes {
		return nil, errInvalidMessage
	}
	body := make(json.RawMessage, length)
	if _, err := io.ReadFull(source, body); err != nil {
		return nil, err
	}
	if !json.Valid(body) {
		return nil, errInvalidMessage
	}
	return body, nil
}

// WriteMessage emits one native message. Callers serialize writes per stream.
func WriteMessage(destination io.Writer, body json.RawMessage) error {
	if len(body) == 0 || len(body) > maxMessageBytes || !json.Valid(body) {
		return errInvalidMessage
	}
	frame := make([]byte, 4+len(body))
	binary.NativeEndian.PutUint32(frame, uint32(len(body)))
	copy(frame[4:], body)
	n, err := destination.Write(frame)
	if err == nil && n != len(frame) {
		return io.ErrShortWrite
	}
	return err
}
