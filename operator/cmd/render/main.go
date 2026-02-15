package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"sigs.k8s.io/yaml"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
	"github.com/dlbewley/ovn-recon-operator/internal/controller"
)

func main() {
	var inputPath string
	flag.StringVar(&inputPath, "f", "", "Path to OvnRecon YAML ('-' for stdin)")
	flag.Parse()

	if inputPath == "" {
		inputPath = filepath.Join("config", "samples", "recon_v1beta1_ovnrecon.yaml")
	}

	data, err := readInput(inputPath)
	if err != nil {
		exitf("read input: %v", err)
	}

	var ovnRecon reconv1beta1.OvnRecon
	if err := yaml.Unmarshal(data, &ovnRecon); err != nil {
		exitf("parse OvnRecon: %v", err)
	}
	if ovnRecon.Name == "" {
		ovnRecon.Name = "ovn-recon"
	}
	if ovnRecon.APIVersion == "" {
		ovnRecon.APIVersion = "recon.bewley.net/v1beta1"
	}
	if ovnRecon.Kind == "" {
		ovnRecon.Kind = "OvnRecon"
	}

	objects := []interface{}{
		controller.DesiredDeployment(&ovnRecon),
		controller.DesiredService(&ovnRecon),
		controller.DesiredConsolePlugin(&ovnRecon),
	}

	for i, obj := range objects {
		out, err := yaml.Marshal(obj)
		if err != nil {
			exitf("render YAML: %v", err)
		}
		if i > 0 {
			fmt.Fprintln(os.Stdout, "---")
		}
		fmt.Fprint(os.Stdout, string(out))
	}
}

func readInput(path string) ([]byte, error) {
	if path == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(path)
}

func exitf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
