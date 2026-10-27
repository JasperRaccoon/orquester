package main

import (
	"testing"

	"orquester/box-agent/internal/agent"
)

func TestParseServiceArgs(t *testing.T) {
	ok := []struct {
		args []string
		want agent.ServiceOptions
	}{
		{nil, agent.ServiceOptions{}},
		{[]string{"--dry-run"}, agent.ServiceOptions{DryRun: true}},
		{[]string{"--data-dir", "/a b"}, agent.ServiceOptions{DataDir: "/a b"}},
		{[]string{"--data-dir=/d", "--dry-run"}, agent.ServiceOptions{DataDir: "/d", DryRun: true}},
		{[]string{"--dry-run", "--data-dir", "/d"}, agent.ServiceOptions{DataDir: "/d", DryRun: true}},
	}
	for _, c := range ok {
		got, err := parseServiceArgs(c.args)
		if err != nil || got != c.want {
			t.Errorf("%q: %+v, %v", c.args, got, err)
		}
	}
	for _, args := range [][]string{
		{"--dryrun"},
		{"--dry-run=true"},
		{"--data-dir"},
		{"--data-dir="},
		{"--data-dir", ""},
		{"extra"},
		{"-n"},
	} {
		if _, err := parseServiceArgs(args); err == nil {
			t.Errorf("%q was accepted", args)
		}
	}
}

func TestServiceCommandsRejectUnknownFlags(t *testing.T) {
	for _, command := range []string{"install-service", "uninstall-service"} {
		if code := run([]string{command, "--dry-run", "--bogus"}); code != 2 {
			t.Errorf("%s --bogus: exit %d", command, code)
		}
	}
}
