package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// gzipWriters recycles compressors: each one carries about a megabyte of
// window and hash state, and the UI polls the snapshot endpoints.
var gzipWriters = sync.Pool{
	New: func() any { return gzip.NewWriter(io.Discard) },
}

// withGzip compresses a handler's 200 responses when the request accepts
// gzip. Snapshot JSON is highly repetitive (the policy tables shrink seven
// to eight times), and the optional sections make a response several times
// larger than the ladder payload. A request that does not accept gzip gets
// the body exactly as the handler wrote it. Error responses stay plain.
func withGzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The representation depends on Accept-Encoding whether or not this
		// particular response ends up compressed.
		w.Header().Add("Vary", "Accept-Encoding")
		if !acceptsGzip(r.Header) {
			next.ServeHTTP(w, r)
			return
		}
		gw := &gzipResponseWriter{ResponseWriter: w}
		defer gw.finish()
		next.ServeHTTP(gw, r)
	})
}

type gzipResponseWriter struct {
	http.ResponseWriter
	gz          *gzip.Writer
	wroteHeader bool
}

func (g *gzipResponseWriter) WriteHeader(status int) {
	if !g.wroteHeader {
		g.wroteHeader = true
		header := g.Header()
		if status == http.StatusOK && header.Get("Content-Encoding") == "" {
			header.Set("Content-Encoding", "gzip")
			header.Del("Content-Length")
			g.gz = gzipWriters.Get().(*gzip.Writer)
			g.gz.Reset(g.ResponseWriter)
		}
	}
	g.ResponseWriter.WriteHeader(status)
}

func (g *gzipResponseWriter) Write(data []byte) (int, error) {
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	if g.gz != nil {
		return g.gz.Write(data)
	}
	return g.ResponseWriter.Write(data)
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (g *gzipResponseWriter) Unwrap() http.ResponseWriter { return g.ResponseWriter }

// finish writes the gzip trailer and returns the compressor to the pool.
func (g *gzipResponseWriter) finish() {
	if g.gz == nil {
		return
	}
	_ = g.gz.Close()
	g.gz.Reset(io.Discard)
	gzipWriters.Put(g.gz)
	g.gz = nil
}

// acceptsGzip reports whether Accept-Encoding allows a gzip response: a
// gzip (or x-gzip) entry with a non-zero q-value, or a non-zero "*" when
// gzip is not listed itself.
func acceptsGzip(header http.Header) bool {
	accepted, explicit := false, false
	for _, value := range header.Values("Accept-Encoding") {
		for _, entry := range strings.Split(value, ",") {
			coding, params, _ := strings.Cut(entry, ";")
			switch strings.ToLower(strings.TrimSpace(coding)) {
			case "gzip", "x-gzip":
				explicit = true
				accepted = qValue(params) > 0
			case "*":
				if !explicit {
					accepted = qValue(params) > 0
				}
			}
		}
	}
	return accepted
}

// qValue reads the q parameter of an Accept-Encoding entry; absent or
// unparseable means 1.
func qValue(params string) float64 {
	for _, param := range strings.Split(params, ";") {
		name, value, found := strings.Cut(strings.TrimSpace(param), "=")
		if !found || !strings.EqualFold(strings.TrimSpace(name), "q") {
			continue
		}
		if q, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
			return q
		}
	}
	return 1
}
