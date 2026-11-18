package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"time"
)

func probeIronCurtainSignalHealth(endpoint string, credentials *ironCurtainSignalCredentials) error {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil {
		return errors.New("Signal bridge health endpoint must use TLS")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(credentials.certPEM) {
		return errors.New("Signal bridge health trust is unavailable")
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: "localhost"}, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Timeout: 3 * time.Second, Transport: transport, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return errors.New("Signal bridge health endpoint is invalid")
	}
	request.Header.Set("Authorization", string(credentials.authorization))
	response, err := client.Do(request)
	if err != nil {
		return errors.New("Signal bridge health TLS request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent || response.Header.Get(ironCurtainSignalAuthHeader) != "1" {
		return errors.New("Signal bridge health admission failed")
	}
	return nil
}

func main() {
	credentials, err := loadIronCurtainSignalCredentials()
	if err == nil {
		if len(os.Args) == 2 && os.Args[1] == "--check-credentials" {
			return
		}
		if len(os.Args) != 1 {
			err = errors.New("Signal bridge health arguments are invalid")
		} else {
			err = probeIronCurtainSignalHealth("https://127.0.0.1:8080/v1/health", credentials)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
