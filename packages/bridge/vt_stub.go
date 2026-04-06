//go:build !windows

package main

func enableVTProcessing()                      {}
func setRawInputMode()                         {}
func getConsoleSize() (int, int)               { return 120, 30 }
func syncConsoleDimensions(cols, rows int)      {}
