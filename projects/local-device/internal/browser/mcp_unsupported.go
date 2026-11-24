//go:build !darwin && !windows

package browser

import (
	"context"
	"errors"
)

func RunMCP(context.Context) error {
	return errors.New("embedded browser MCP requires macOS or Windows")
}
