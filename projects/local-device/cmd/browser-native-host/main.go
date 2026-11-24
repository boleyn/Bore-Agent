package main

import (
	"log"
	"os"

	"fastgpt.local/local-device/internal/browser/native"
)

func main() {
	args := os.Args[1:]
	if len(args) == 3 && args[0] == "register" {
		executable, err := os.Executable()
		if err == nil {
			err = native.Register(args[1], executable, args[2])
		}
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	if len(args) == 2 && args[0] == "unregister" {
		if err := native.Unregister(args[1]); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := native.RunHost(); err != nil {
		log.Fatal("browser native session ended")
	}
}
