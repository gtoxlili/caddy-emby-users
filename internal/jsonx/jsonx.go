// Package jsonx decodes JSON into values that re-encode with their original
// key order and number spelling. Emby responses pass through the plugin with
// a few fields changed; clients that parse strictly see the same shape the
// upstream server produced.
package jsonx

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Object is a JSON object that remembers key order.
type Object struct {
	keys []string
	vals map[string]any
}

// NewObject returns an empty object.
func NewObject() *Object { return &Object{vals: map[string]any{}} }

// Get returns the value stored under k.
func (o *Object) Get(k string) (any, bool) {
	v, ok := o.vals[k]
	return v, ok
}

// Set stores v under k, keeping the position of an existing key.
func (o *Object) Set(k string, v any) *Object {
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
	return o
}

// Delete removes k.
func (o *Object) Delete(k string) {
	if _, ok := o.vals[k]; !ok {
		return
	}
	delete(o.vals, k)
	for i, key := range o.keys {
		if key == k {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			return
		}
	}
}

// Keys returns the keys in order.
func (o *Object) Keys() []string { return o.keys }

// String returns the value under k if it is a string.
func (o *Object) String(k string) string {
	s, _ := o.vals[k].(string)
	return s
}

// Bool returns the value under k if it is a boolean.
func (o *Object) Bool(k string) bool {
	b, _ := o.vals[k].(bool)
	return b
}

// Int returns the value under k if it is an integral number.
func (o *Object) Int(k string) (int64, bool) {
	n, ok := o.vals[k].(json.Number)
	if !ok {
		return 0, false
	}
	i, err := n.Int64()
	if err != nil {
		f, ferr := n.Float64()
		if ferr != nil {
			return 0, false
		}
		return int64(f), true
	}
	return i, true
}

// Object returns the nested object under k.
func (o *Object) Object(k string) *Object {
	v, _ := o.vals[k].(*Object)
	return v
}

// Clone copies the object one level deep.
func (o *Object) Clone() *Object {
	c := &Object{keys: append([]string(nil), o.keys...), vals: make(map[string]any, len(o.vals))}
	for k, v := range o.vals {
		c.vals[k] = v
	}
	return c
}

// MarshalJSON writes the object with keys in their stored order.
func (o *Object) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	if err := encode(&buf, o); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Decode parses a JSON document. Objects become *Object, arrays []any,
// numbers json.Number.
func Decode(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("jsonx: trailing data after document")
	}
	return v, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := NewObject()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, fmt.Errorf("jsonx: object key is %T", kt)
				}
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				o.Set(k, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("jsonx: unexpected delimiter %v", t)
	default:
		return tok, nil
	}
}

// Encode writes v as compact JSON without HTML escaping.
func Encode(v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := encode(&buf, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func encode(buf *bytes.Buffer, v any) error {
	switch t := v.(type) {
	case *Object:
		if t == nil {
			buf.WriteString("null")
			return nil
		}
		buf.WriteByte('{')
		for i, k := range t.keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := encodeScalar(buf, k); err != nil {
				return err
			}
			buf.WriteByte(':')
			if err := encode(buf, t.vals[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case []any:
		buf.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := encode(buf, e); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case json.Number:
		buf.WriteString(t.String())
	default:
		return encodeScalar(buf, v)
	}
	return nil
}

func encodeScalar(buf *bytes.Buffer, v any) error {
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return err
	}
	// Encoder.Encode appends a newline.
	buf.Truncate(buf.Len() - 1)
	return nil
}

// Walk calls fn for every object in v, parents before children.
func Walk(v any, fn func(*Object)) {
	switch t := v.(type) {
	case *Object:
		fn(t)
		for _, k := range t.keys {
			Walk(t.vals[k], fn)
		}
	case []any:
		for _, e := range t {
			Walk(e, fn)
		}
	}
}
