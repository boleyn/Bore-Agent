package native

import (
	"io"
	"net"
)

// Relay forwards complete Native Messaging frames in both directions. Closing
// either peer ends the host session and releases the connector connection.
func Relay(extensionInput io.ReadCloser, extensionOutput io.WriteCloser, connector net.Conn) error {
	finished := make(chan error, 2)
	forward := func(source io.Reader, destination io.Writer) {
		for {
			message, err := ReadMessage(source)
			if err == nil {
				err = WriteMessage(destination, message)
			}
			if err != nil {
				finished <- err
				return
			}
		}
	}
	go forward(extensionInput, connector)
	go forward(connector, extensionOutput)
	err := <-finished
	_ = connector.Close()
	_ = extensionInput.Close()
	_ = extensionOutput.Close()
	return err
}
