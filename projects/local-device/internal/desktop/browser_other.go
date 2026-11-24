//go:build !darwin && !windows && !headless

package desktop

import (
	"context"

	"fastgpt.local/local-device/internal/connector"
)

func configureBrowser(context.Context, *connector.StartOptions) func(bool) error {
	return nil
}
