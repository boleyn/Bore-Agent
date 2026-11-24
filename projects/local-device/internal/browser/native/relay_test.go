package native

import (
	"io"
	"net"
	"testing"
	"time"
)

func TestRelayForwardsBothDirectionsAndClosesOnDisconnect(t *testing.T) {
	connector, host := net.Pipe()
	defer connector.Close()
	input, extensionWrite := io.Pipe()
	extensionRead, output := io.Pipe()
	defer extensionRead.Close()
	defer extensionWrite.Close()
	if err := connector.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- Relay(input, output, host) }()

	toConnector := make(chan error, 1)
	go func() {
		toConnector <- WriteMessage(extensionWrite, []byte(`{"type":"offer"}`))
	}()
	message, err := ReadMessage(connector)
	if err != nil || string(message) != `{"type":"offer"}` {
		t.Fatalf("connector received %s, %v", message, err)
	}
	if err := <-toConnector; err != nil {
		t.Fatal(err)
	}

	toExtension := make(chan error, 1)
	go func() {
		toExtension <- WriteMessage(connector, []byte(`{"type":"approved"}`))
	}()
	message, err = ReadMessage(extensionRead)
	if err != nil || string(message) != `{"type":"approved"}` {
		t.Fatalf("extension received %s, %v", message, err)
	}
	if err := <-toExtension; err != nil {
		t.Fatal(err)
	}
	_ = extensionWrite.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("relay did not close after extension disconnected")
	}
}
