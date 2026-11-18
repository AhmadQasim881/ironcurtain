{
  description = "IronCurtain - Secure agent runtime with trusted process mediation";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # package.json "engines": ^24.0.0 || ^26.0.0 (isolated-vm needs >= 24).
            # test/dev-environment.test.ts keeps this in sync with package.json.
            nodejs_24
            # node-gyp's interpreter for the native modules (isolated-vm,
            # node-pty); mkShell's stdenv already provides the C/C++ compiler
            # and make.
            python3
            # The Go components: docker/nested-relay (go vet/go test) and
            # docker/build-trust-runtime (`npm run check:build-trust-runtime`).
            # Their go.mod and manifest.json pin the exact 1.26.x release
            # (scripts/check-go-toolchain.ts); `nix flake update` when the
            # locked nixpkgs ships an older one.
            go_1_26
            # sandbox-runtime (the OS sandbox for MCP servers) needs socat and
            # ripgrep on Linux, plus bubblewrap below.
            socat
            ripgrep
            git
          ] ++ lib.optionals stdenv.hostPlatform.isLinux [
            bubblewrap
          ];

          # package.json "allowScripts" denies onnxruntime-node's install
          # script, but only npm 11.19 and later enforce it; this skips it with
          # any npm (it only downloads optional CUDA binaries).
          ONNXRUNTIME_NODE_INSTALL = "skip";
        };
      });
}
