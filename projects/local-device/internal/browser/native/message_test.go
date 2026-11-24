package native

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func TestReadSequentialMessages(t *testing.T) {
	var pipe bytes.Buffer
	for _, body := range []string{`{"type":"ready"}`, `{"type":"stop"}`} {
		if err := WriteMessage(&pipe, []byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	for _, expected := range []string{`{"type":"ready"}`, `{"type":"stop"}`} {
		got, err := ReadMessage(&pipe)
		if err != nil || string(got) != expected {
			t.Fatalf("ReadMessage = %s, %v; want %s", got, err, expected)
		}
	}
	if _, err := ReadMessage(&pipe); !errors.Is(err, io.EOF) {
		t.Fatalf("expected EOF, got %v", err)
	}
}

func TestReadRejectsOversizedMessageBeforeReadingPayload(t *testing.T) {
	var header [4]byte
	binary.NativeEndian.PutUint32(header[:], maxMessageBytes+1)
	if _, err := ReadMessage(bytes.NewReader(header[:])); !errors.Is(err, errInvalidMessage) {
		t.Fatalf("expected invalid message, got %v", err)
	}
}
