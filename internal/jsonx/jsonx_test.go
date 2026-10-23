package jsonx

import "testing"

// property: decoding then encoding compact JSON gives back the same bytes, so
// a response the plugin rewrites keeps the upstream server's key order and
// number spelling everywhere it did not change a value.
func TestRoundTripKeepsBytes(t *testing.T) {
	for _, doc := range []string{
		`{"Name":"爱·回家","Id":"e01KZSTVNQBHVSK3EVYZ7RJPB05","RunTimeTicks":13670000000,"PlayedPercentage":1.6835663338088442,"UserData":{"Played":false,"Key":"x"},"Tags":[],"Overview":"<b>&amp;</b> \"quoted\" \\ \u0001","Nothing":null}`,
		`[{"b":1,"a":2},[1.0,2e10,-0.5],"s",true,false,null]`,
		`{"z":{"y":{"x":[]}},"a":{}}`,
	} {
		v, err := Decode([]byte(doc))
		if err != nil {
			t.Fatalf("decode %s: %v", doc, err)
		}
		out, err := Encode(v)
		if err != nil {
			t.Fatal(err)
		}
		if string(out) != doc {
			t.Errorf("round trip changed the document:\n got %s\nwant %s", out, doc)
		}
	}
}
