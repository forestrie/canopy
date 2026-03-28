// Command go-cose-goldens emits JSON test vectors that match veraison/go-cose
// Sig_structure / CBOR behavior (same EncOptions as go-cose cbor.go).
//
// Regenerate committed goldens:
//
//	cd packages/shared/encoding/tools/go-cose-goldens && go run . > ../../src/testdata/go-cose-goldens.json
//
// SPDX: deterministicBinaryString logic derives from github.com/veraison/go-cose (cbor.go).
package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/fxamacker/cbor/v2"
	"github.com/veraison/go-cose"
)

var encMode cbor.EncMode
var decModeTagsForbidden cbor.DecMode

func init() {
	encOpts := cbor.EncOptions{
		Sort:        cbor.SortCoreDeterministic,
		IndefLength: cbor.IndefLengthForbidden,
	}
	var err error
	encMode, err = encOpts.EncMode()
	if err != nil {
		panic(err)
	}
	decOpts := cbor.DecOptions{
		DupMapKey:   cbor.DupMapKeyEnforcedAPF,
		IndefLength: cbor.IndefLengthForbidden,
		IntDec:      cbor.IntDecConvertSigned,
		TagsMd:      cbor.TagsForbidden,
	}
	decModeTagsForbidden, err = decOpts.DecMode()
	if err != nil {
		panic(err)
	}
}

func deterministicBinaryString(data cbor.RawMessage) (cbor.RawMessage, error) {
	if len(data) == 0 {
		return nil, io.EOF
	}
	if data[0]>>5 != 2 {
		return nil, errors.New("cbor: require bstr type")
	}
	if err := decModeTagsForbidden.Wellformed(data); err != nil {
		return nil, err
	}
	ai := data[0] & 0x1f
	if ai < 24 {
		return data, nil
	}
	switch ai {
	case 24:
		if data[1] >= 24 {
			return data, nil
		}
	case 25:
		if data[1] != 0 {
			return data, nil
		}
	case 26:
		if data[1] != 0 || data[2] != 0 {
			return data, nil
		}
	case 27:
		if data[1] != 0 || data[2] != 0 || data[3] != 0 || data[4] != 0 {
			return data, nil
		}
	}
	var s []byte
	_ = decModeTagsForbidden.Unmarshal(data, &s)
	return encMode.Marshal(s)
}

// referenceSigStructure matches go-cose sign1.go (*Sign1Message).toBeSigned for the
// same protected header map bytes, external AAD, and payload bytes.
func referenceSigStructure(
	ph cose.ProtectedHeader,
	external []byte,
	payload []byte,
) ([]byte, error) {
	raw, err := ph.MarshalCBOR()
	if err != nil {
		return nil, err
	}
	bodyProt, err := deterministicBinaryString(raw)
	if err != nil {
		return nil, err
	}
	if external == nil {
		external = []byte{}
	}
	return encMode.Marshal([]any{
		"Signature1",
		cbor.RawMessage(bodyProt),
		external,
		payload,
	})
}

type bstrVec struct {
	Name        string `json:"name"`
	PayloadHex  string `json:"payloadHex"`
	EncodingHex string `json:"encodingHex"`
}

type sigVec struct {
	Name            string `json:"name"`
	ProtectedMapHex string `json:"protectedMapInnerHex"`
	ExternalAadHex  string `json:"externalAadHex"`
	PayloadHex      string `json:"payloadHex"`
	SigStructureHex string `json:"sigStructureHex"`
}

type output struct {
	GoCose      string   `json:"goCoseVersion"`
	FxCbor      string   `json:"fxamackerCborVersion"`
	Description string   `json:"description"`
	Bstr        []bstrVec `json:"bstrVectors"`
	Sig         []sigVec  `json:"sigStructureVectors"`
}

func mustHex(b []byte) string { return hex.EncodeToString(b) }

func main() {
	out := output{
		GoCose:      "v1.3.0",
		FxCbor:      "v2.9.0",
		Description: "Sig_structure bytes align with github.com/veraison/go-cose Sign1Message.toBeSigned",
	}

	// --- bstr canonical encodings (same as COSE body_protected / AAD / payload bstr items)
	lengths := []int{0, 1, 23, 24, 25, 255, 256}
	for _, n := range lengths {
		p := make([]byte, n)
		for i := range p {
			p[i] = 0xcc
		}
		enc, err := encMode.Marshal(p)
		if err != nil {
			panic(err)
		}
		out.Bstr = append(out.Bstr, bstrVec{
			Name:        "bstr_len_" + itoa(n),
			PayloadHex:  mustHex(p),
			EncodingHex: mustHex(enc),
		})
	}

	kidPattern := make([]byte, 16)
	for i := range kidPattern {
		kidPattern[i] = byte(i + 1)
	}

	payload32 := make([]byte, 32)
	for i := range payload32 {
		payload32[i] = byte(i * 11)
	}

	// 1) Forestrie Custodian protected header (matches custodian BuildCustodianCOSESign1)
	phCustodian := cose.ProtectedHeader{
		cose.HeaderLabelAlgorithm:   cose.AlgorithmES256,
		cose.HeaderLabelContentType: "application/forestrie.custodian-statement+cbor",
		cose.HeaderLabelKeyID:       kidPattern,
	}
	innerCust, err := encMode.Marshal(map[any]any(phCustodian))
	if err != nil {
		panic(err)
	}
	sigCust, err := referenceSigStructure(phCustodian, nil, payload32)
	if err != nil {
		panic(err)
	}
	out.Sig = append(out.Sig, sigVec{
		Name:            "custodian_profile_es256_empty_aad",
		ProtectedMapHex: mustHex(innerCust),
		ExternalAadHex:  "",
		PayloadHex:      mustHex(payload32),
		SigStructureHex: mustHex(sigCust),
	})

	// 2) Statement-style protected header: only kid (maps to encodeCoseProtectedMapBytes)
	phKidOnly := cose.ProtectedHeader{
		cose.HeaderLabelKeyID: append([]byte(nil), kidPattern...),
	}
	innerKid, err := encMode.Marshal(map[any]any(phKidOnly))
	if err != nil {
		panic(err)
	}
	sigKid, err := referenceSigStructure(phKidOnly, nil, payload32)
	if err != nil {
		panic(err)
	}
	out.Sig = append(out.Sig, sigVec{
		Name:            "protected_kid_only_empty_aad",
		ProtectedMapHex: mustHex(innerKid),
		ExternalAadHex:  "",
		PayloadHex:      mustHex(payload32),
		SigStructureHex: mustHex(sigKid),
	})

	// 3) Non-empty external AAD
	ext := []byte{0x01, 0x02, 0x03}
	sigExt, err := referenceSigStructure(phCustodian, ext, payload32)
	if err != nil {
		panic(err)
	}
	out.Sig = append(out.Sig, sigVec{
		Name:            "custodian_profile_nonzero_external_aad",
		ProtectedMapHex: mustHex(innerCust),
		ExternalAadHex:  mustHex(ext),
		PayloadHex:      mustHex(payload32),
		SigStructureHex: mustHex(sigExt),
	})

	// 4) Zero-length payload
	sigZ, err := referenceSigStructure(phCustodian, nil, []byte{})
	if err != nil {
		panic(err)
	}
	out.Sig = append(out.Sig, sigVec{
		Name:            "custodian_empty_payload_bstr",
		ProtectedMapHex: mustHex(innerCust),
		ExternalAadHex:  "",
		PayloadHex:      "",
		SigStructureHex: mustHex(sigZ),
	})

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
}

func itoa(n int) string { return fmt.Sprintf("%d", n) }
