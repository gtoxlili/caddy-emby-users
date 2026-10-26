package embyusers

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
)

// avatar is the picture every local account carries (UserDto.PrimaryImageTag,
// GET /Users/{Id}/Images/Primary). Clients such as Lenna show the signed-in
// user's picture as the server's icon, so it doubles as the site's icon.
type avatar struct {
	data []byte
	tag  string
}

func loadAvatar(path string) (*avatar, error) {
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("emby_users: user_image: %w", err)
	}
	if ctype := http.DetectContentType(data); !strings.HasPrefix(ctype, "image/") {
		return nil, fmt.Errorf("emby_users: user_image %s is %s, not an image", path, ctype)
	}
	sum := sha256.Sum256(data)
	return &avatar{data: data, tag: hex.EncodeToString(sum[:8])}, nil
}

// userImage answers GET /Users/{Id}/Images/{Type}[/{Index}]. Emby serves
// images without a token; every account shows the configured picture.
func (a *app) userImage(w http.ResponseWriter, rc *reqCtx, _ caddyhttp.Handler) error {
	if a.avatar == nil || rc.segs[3] != "primary" {
		return writeText(w, http.StatusNotFound, textNotFound)
	}
	w.Header().Set("ETag", `"`+a.avatar.tag+`"`)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeContent(w, rc.r, "", time.Time{}, bytes.NewReader(a.avatar.data))
	return nil
}
