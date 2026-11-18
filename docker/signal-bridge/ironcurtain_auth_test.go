package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var testMaterialOnce sync.Once
var testMaterial map[string]any
var testMaterialError error

func signalTestMaterial(t *testing.T) map[string]any {
	t.Helper()
	testMaterialOnce.Do(func() {
		key, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			testMaterialError = err
			return
		}
		now := time.Now()
		template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
		der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
		if err != nil {
			testMaterialError = err
			return
		}
		keyDER, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			testMaterialError = err
			return
		}
		testMaterial = map[string]any{"version": 1, "token": strings.Repeat("a", 64), "certPem": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), "keyPem": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))}
	})
	if testMaterialError != nil {
		t.Fatal(testMaterialError)
	}
	copy := map[string]any{}
	for key, value := range testMaterial {
		copy[key] = value
	}
	return copy
}

func signalTestJSON(t *testing.T, fields map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func signalTestCredentials(t *testing.T) *ironCurtainSignalCredentials {
	t.Helper()
	result, err := parseIronCurtainSignalCredentials(signalTestJSON(t, signalTestMaterial(t)), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestSignalCredentialsStrictSchema(t *testing.T) {
	valid := signalTestJSON(t, signalTestMaterial(t))
	cases := map[string][]byte{
		"trailing object": append(append([]byte{}, valid...), []byte(" {}")...),
		"duplicate field": []byte(strings.Replace(string(valid), `"version":1`, `"version":1,"version":1`, 1)),
		"unknown field":   []byte(strings.Replace(string(valid), `"version":1`, `"version":1,"extra":true`, 1)),
		"array":           []byte(`[]`),
		"partial":         valid[:len(valid)-1],
		"oversized":       []byte(strings.Repeat(" ", ironCurtainSignalCredentialsLimit+1)),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := parseIronCurtainSignalCredentials(data, time.Now()); err == nil {
				t.Fatal("invalid credentials accepted")
			}
		})
	}
	for name, mutate := range map[string]func(map[string]any){
		"version":             func(f map[string]any) { f["version"] = 2 },
		"wrong version type":  func(f map[string]any) { f["version"] = "1" },
		"uppercase token":     func(f map[string]any) { f["token"] = strings.Repeat("A", 64) },
		"short token":         func(f map[string]any) { f["token"] = "a" },
		"missing token":       func(f map[string]any) { delete(f, "token") },
		"missing certificate": func(f map[string]any) { delete(f, "certPem") },
		"invalid key":         func(f map[string]any) { f["keyPem"] = "not a key" },
		"extra certificate":   func(f map[string]any) { f["certPem"] = f["certPem"].(string) + f["certPem"].(string) },
	} {
		t.Run(name, func(t *testing.T) {
			f := signalTestMaterial(t)
			mutate(f)
			_, err := parseIronCurtainSignalCredentials(signalTestJSON(t, f), time.Now())
			if err == nil {
				t.Fatal("invalid credentials accepted")
			}
			if strings.Contains(err.Error(), strings.Repeat("a", 64)) || strings.Contains(err.Error(), "PRIVATE KEY") {
				t.Fatal("credential material appeared in error")
			}
		})
	}
	if _, err := parseIronCurtainSignalCredentials(valid, time.Now().Add(2*time.Hour)); err == nil {
		t.Fatal("expired certificate accepted")
	}
}

func TestSignalCredentialFileIsBoundedPrivateAndNoFollow(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")
	data := signalTestJSON(t, signalTestMaterial(t))
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readIronCurtainSignalCredentials(path, time.Now()); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "linked.json")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readIronCurtainSignalCredentials(link, time.Now()); err == nil {
		t.Fatal("linked credentials accepted")
	}
	if _, err := readIronCurtainSignalCredentials(dir, time.Now()); err == nil {
		t.Fatal("directory credentials accepted")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := readIronCurtainSignalCredentials(path, time.Now()); err == nil {
		t.Fatal("public credentials accepted")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Repeat(" ", ironCurtainSignalCredentialsLimit+1)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readIronCurtainSignalCredentials(path, time.Now()); err == nil {
		t.Fatal("oversized file accepted")
	}
	t.Setenv(ironCurtainSignalCredentialsEnv, path)
	if _, err := loadIronCurtainSignalCredentials(); err == nil {
		t.Fatal("non-fixed credential path accepted")
	}
}

func TestSignalAdmissionPrecedesEveryRoute(t *testing.T) {
	credentials := signalTestCredentials(t)
	for _, route := range []struct {
		method, path string
		upgrade      bool
	}{{"GET", "/v1/health", false}, {"POST", "/v1/register/+15550000000", false}, {"GET", "/v1/identities/+15550000000", false}, {"POST", "/v2/send", false}, {"OPTIONS", "/v2/send", false}, {"OPTIONS", "*", false}, {"GET", "/unknown", false}, {"GET", "/v1/health/", false}, {"GET", "/v1/receive/+15550000000", true}} {
		for _, kind := range []string{"missing", "wrong", "duplicate", "query only", "comma joined", "valid"} {
			t.Run(route.method+route.path+kind, func(t *testing.T) {
				target := route.path
				if kind == "query only" && target != "*" {
					target += "?token=" + strings.Repeat("a", 64)
				}
				request := httptest.NewRequest(route.method, target, nil)
				if route.upgrade {
					request.Header.Set("Connection", "Upgrade")
					request.Header.Set("Upgrade", "websocket")
				}
				switch kind {
				case "wrong":
					request.Header.Set("Authorization", "Bearer "+strings.Repeat("b", 64))
				case "duplicate":
					request.Header.Add("Authorization", string(credentials.authorization))
					request.Header.Add("Authorization", string(credentials.authorization))
				case "comma joined":
					request.Header.Set("Authorization", string(credentials.authorization)+", "+string(credentials.authorization))
				case "valid":
					request.Header.Set("Authorization", string(credentials.authorization))
				}
				called := false
				writer := httptest.NewRecorder()
				handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if !authorizeIronCurtainSignalRequest(w, r, credentials) {
						return
					}
					called = true
					if route.upgrade {
						w.WriteHeader(http.StatusSwitchingProtocols)
					} else {
						w.WriteHeader(http.StatusNoContent)
					}
				})
				handler.ServeHTTP(writer, request)
				if writer.Header().Get(ironCurtainSignalAuthHeader) != "1" {
					t.Fatal("missing transport contract header")
				}
				if kind == "valid" {
					if !called || (writer.Code != 204 && writer.Code != 101) {
						t.Fatal("valid request did not reach handler")
					}
				} else if called || writer.Code != 401 {
					t.Fatal("unauthorized request reached handler")
				}
			})
		}
	}
}

func TestSignalHealthRequiresTLSAdmissionAndContract(t *testing.T) {
	credentials := signalTestCredentials(t)
	status := 204
	marker := true
	calls := 0
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if !authorizeIronCurtainSignalRequest(w, r, credentials) {
			return
		}
		if !marker {
			w.Header().Del(ironCurtainSignalAuthHeader)
		}
		if status == 302 {
			w.Header().Set("Location", "/redirect")
		}
		w.WriteHeader(status)
	}))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{credentials.certificate}}
	server.StartTLS()
	defer server.Close()
	if err := probeIronCurtainSignalHealth(server.URL+"/v1/health", credentials); err != nil {
		t.Fatal(err)
	}
	marker = false
	if err := probeIronCurtainSignalHealth(server.URL+"/v1/health", credentials); err == nil {
		t.Fatal("unmarked health accepted")
	}
	marker = true
	status = 302
	before := calls
	if err := probeIronCurtainSignalHealth(server.URL+"/v1/health", credentials); err == nil || calls != before+1 {
		t.Fatal("redirect followed or accepted")
	}
	status = 204
	wrong := *credentials
	wrong.authorization = []byte("Bearer " + strings.Repeat("b", 64))
	if err := probeIronCurtainSignalHealth(server.URL+"/v1/health", &wrong); err == nil {
		t.Fatal("wrong-token health accepted")
	}
	before = calls
	if err := probeIronCurtainSignalHealth(strings.Replace(server.URL, "https:", "http:", 1), credentials); err == nil || calls != before {
		t.Fatal("plaintext health attempted or accepted")
	}
}

func TestSignalCredentialsRejectsCertificateAuthority(t *testing.T) {
	fields := signalTestMaterial(t)
	block, _ := pem.Decode([]byte(fields["keyPem"].(string)))
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	rsaKey := key.(*rsa.PrivateKey)
	certificate := *signalTestCredentials(t).certificate.Leaf
	certificate.SerialNumber = big.NewInt(2)
	certificate.IsCA = true
	certificate.KeyUsage |= x509.KeyUsageCertSign
	der, err := x509.CreateCertificate(rand.Reader, &certificate, &certificate, &rsaKey.PublicKey, rsaKey)
	if err != nil {
		t.Fatal(err)
	}
	fields["certPem"] = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	if _, err := parseIronCurtainSignalCredentials(signalTestJSON(t, fields), time.Now()); err == nil {
		t.Fatal("CA certificate accepted as a server leaf")
	}
}

func TestEntrypointRejectsLeadingZeroIdentity(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("host-side validation fixture deliberately never runs the root wrapper branch")
	}
	command := exec.Command("/bin/sh", "entrypoint.sh")
	command.Env = []string{"PATH=/usr/bin:/bin", "MODE=json-rpc", "PORT=8080", ironCurtainSignalCredentialsEnv + "=" + ironCurtainSignalCredentialsFile, "SIGNAL_BRIDGE_UID=00", "SIGNAL_BRIDGE_GID=1000"}
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "positive decimal integers") {
		t.Fatal("noncanonical zero identity was not refused before startup")
	}
}
