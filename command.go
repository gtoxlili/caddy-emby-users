package embyusers

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	caddycmd "github.com/caddyserver/caddy/v2/cmd"
	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/gtoxlili/caddy-emby-users/internal/store"
)

func init() {
	caddycmd.RegisterCommand(caddycmd.Command{
		Name:  "emby-users",
		Usage: "passwd <name> [--admin] | list   [--db <path>]",
		Short: "Manages accounts of the emby_users handler",
		Long: `Manages the accounts the emby_users handler signs people in with.

Everything else is done over Emby's own user endpoints by an administrator.
This command exists to create that first administrator:

  caddy emby-users passwd alice --admin

The password is read from the terminal, or from the first line of standard
input when it is not a terminal. The command works on a running server's
database; signed-in sessions are not affected.`,
		CobraFunc: func(cmd *cobra.Command) {
			cmd.PersistentFlags().String("db", "", "database file (default: emby-users.db in Caddy's data directory)")

			passwd := &cobra.Command{
				Use:   "passwd <name>",
				Short: "Creates an account or sets its password",
				Args:  cobra.ExactArgs(1),
				RunE: func(c *cobra.Command, args []string) error {
					admin, _ := c.Flags().GetBool("admin")
					return runPasswd(c, args[0], admin)
				},
			}
			passwd.Flags().Bool("admin", false, "make the account an administrator")

			list := &cobra.Command{
				Use:   "list",
				Short: "Lists accounts",
				Args:  cobra.NoArgs,
				RunE:  runList,
			}
			cmd.AddCommand(passwd, list)
		},
	})
}

func openFromFlags(c *cobra.Command) (*store.Store, error) {
	path, _ := c.Flags().GetString("db")
	if path == "" {
		path = defaultDatabase()
	}
	return store.Open(path)
}

func runPasswd(c *cobra.Command, name string, admin bool) error {
	if !validName(name) {
		return errors.New("name must be 1 to 64 characters without slashes or surrounding spaces")
	}
	pw, err := readPassword()
	if err != nil {
		return err
	}
	if pw == "" {
		return errors.New("password must not be empty")
	}
	st, err := openFromFlags(c)
	if err != nil {
		return err
	}
	defer st.Close()
	ctx := context.Background()
	u, err := st.UserByName(ctx, name)
	if err != nil {
		return err
	}
	if u == nil {
		if _, err := st.CreateUser(ctx, name, pw, admin); err != nil {
			return err
		}
		fmt.Fprintf(c.OutOrStdout(), "created %s\n", name)
		return nil
	}
	if err := st.SetPassword(ctx, u.ID, pw); err != nil {
		return err
	}
	if admin && !u.Admin {
		if err := st.SetFlags(ctx, u.ID, true, u.Disabled); err != nil {
			return err
		}
	}
	fmt.Fprintf(c.OutOrStdout(), "updated %s\n", u.Name)
	return nil
}

func readPassword() (string, error) {
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, "Password: ")
		first, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		fmt.Fprint(os.Stderr, "Again: ")
		second, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		if string(first) != string(second) {
			return "", errors.New("passwords do not match")
		}
		return string(first), nil
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func runList(c *cobra.Command, _ []string) error {
	st, err := openFromFlags(c)
	if err != nil {
		return err
	}
	defer st.Close()
	users, err := st.Users(context.Background())
	if err != nil {
		return err
	}
	out := c.OutOrStdout()
	for _, u := range users {
		var flags []string
		if u.Admin {
			flags = append(flags, "admin")
		}
		if u.Disabled {
			flags = append(flags, "disabled")
		}
		if !u.HasPassword {
			flags = append(flags, "no password")
		}
		fmt.Fprintf(out, "%s  %s  %s\n", u.ID, u.Name, strings.Join(flags, ","))
	}
	return nil
}
