package main

import (
	"bytes"
	"crypto/rsa"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"os"
	"syscall"
	"time"
)

const ironCurtainSignalCredentialsFile = "/run/ironcurtain-signal-auth/credentials.json"
const ironCurtainSignalCredentialsEnv = "IRONCURTAIN_SIGNAL_CREDENTIALS_FILE"
const ironCurtainSignalAuthHeader = "X-IronCurtain-Signal-Auth"
const ironCurtainSignalCredentialsLimit = 32768

// Kept private so formatting a public endpoint cannot expose admission material.
type ironCurtainSignalCredentials struct {
	authorization []byte
	certificate   tls.Certificate
	certPEM       []byte
}

func loadIronCurtainSignalCredentials() (*ironCurtainSignalCredentials, error) {
	if os.Getenv(ironCurtainSignalCredentialsEnv) != ironCurtainSignalCredentialsFile {
		return nil, errors.New("Signal bridge credentials file is not configured at the required path")
	}
	return readIronCurtainSignalCredentials(ironCurtainSignalCredentialsFile, time.Now())
}

func readIronCurtainSignalCredentials(path string, now time.Time) (*ironCurtainSignalCredentials, error) {
	// O_NONBLOCK prevents an unexpected FIFO from hanging startup before fstat.
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, errors.New("Signal bridge credentials file is unavailable")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("Signal bridge credentials file must be a private regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, ironCurtainSignalCredentialsLimit+1))
	if err != nil || len(data) > ironCurtainSignalCredentialsLimit {
		return nil, errors.New("Signal bridge credentials file exceeds its size limit or cannot be read")
	}
	return parseIronCurtainSignalCredentials(data, now)
}

func parseIronCurtainSignalCredentials(data []byte, now time.Time) (*ironCurtainSignalCredentials, error) {
	invalid := func() (*ironCurtainSignalCredentials, error) {
		return nil, errors.New("Signal bridge credentials are malformed or invalid")
	}
	if len(data) > ironCurtainSignalCredentialsLimit {
		return invalid()
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return invalid()
	}
	seen := map[string]bool{}
	version := 0
	var token, certText, keyText string
	for decoder.More() {
		key, err := decoder.Token()
		name, ok := key.(string)
		if err != nil || !ok || seen[name] {
			return invalid()
		}
		seen[name] = true
		switch name {
		case "version":
			err = decoder.Decode(&version)
		case "token":
			err = decoder.Decode(&token)
		case "certPem":
			err = decoder.Decode(&certText)
		case "keyPem":
			err = decoder.Decode(&keyText)
		default:
			return invalid()
		}
		if err != nil {
			return invalid()
		}
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') || len(seen) != 4 || version != 1 {
		return invalid()
	}
	if _, err := decoder.Token(); err != io.EOF {
		return invalid()
	}
	if len(token) != 64 {
		return invalid()
	}
	for _, character := range []byte(token) {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return invalid()
		}
	}
	certPEM, keyPEM := []byte(certText), []byte(keyText)
	certBlock, certRest := pem.Decode(certPEM)
	keyBlock, keyRest := pem.Decode(keyPEM)
	if certBlock == nil || certBlock.Type != "CERTIFICATE" || len(bytes.TrimSpace(certRest)) != 0 ||
		keyBlock == nil || (keyBlock.Type != "PRIVATE KEY" && keyBlock.Type != "RSA PRIVATE KEY") || len(bytes.TrimSpace(keyRest)) != 0 {
		return invalid()
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil || len(pair.Certificate) != 1 {
		return invalid()
	}
	certificate, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil || !bytes.Equal(certificate.RawIssuer, certificate.RawSubject) ||
		certificate.CheckSignature(certificate.SignatureAlgorithm, certificate.RawTBSCertificate, certificate.Signature) != nil {
		return invalid()
	}
	publicKey, ok := certificate.PublicKey.(*rsa.PublicKey)
	if certificate.IsCA || !ok || publicKey.N.BitLen() < 2048 || certificate.VerifyHostname("localhost") != nil || certificate.VerifyHostname("127.0.0.1") != nil {
		return invalid()
	}
	hasServerUsage := false
	for _, usage := range certificate.ExtKeyUsage {
		if usage == x509.ExtKeyUsageServerAuth {
			hasServerUsage = true
		}
	}
	if !hasServerUsage || certificate.KeyUsage&x509.KeyUsageDigitalSignature == 0 {
		return invalid()
	}
	roots := x509.NewCertPool()
	roots.AddCert(certificate)
	if _, err := certificate.Verify(x509.VerifyOptions{Roots: roots, DNSName: "localhost", CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
		return invalid()
	}
	pair.Leaf = certificate
	return &ironCurtainSignalCredentials{authorization: []byte("Bearer " + token), certificate: pair, certPEM: certPEM}, nil
}

// Called before Gin's logger, recovery and every route, including upgrades.
func authorizeIronCurtainSignalRequest(writer http.ResponseWriter, request *http.Request, credentials *ironCurtainSignalCredentials) bool {
	writer.Header().Set(ironCurtainSignalAuthHeader, "1")
	values := request.Header.Values("Authorization")
	if len(values) != 1 || len(values[0]) != len(credentials.authorization) || subtle.ConstantTimeCompare([]byte(values[0]), credentials.authorization) != 1 {
		writer.Header().Set("Cache-Control", "no-store")
		writer.WriteHeader(http.StatusUnauthorized)
		return false
	}
	return true
}
