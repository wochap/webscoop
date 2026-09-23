{
  description = "webscoop: record scrapers by clicking, run them unattended from the command line";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?rev=0ad6f47ea4fe188f4bc8f0380f93ae8523337c6c"; # nixos-26.05 (10 jul 2026)
  };

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = nixpkgs.lib;

      nodejs = pkgs.nodejs_22;
      # Must match `packageManager` in package.json.
      pnpm = pkgs.pnpm_11;
      # nixpkgs' playwright-driver must match the `playwright` version pinned in
      # package.json, so Playwright finds its Chromium build in the Nix store.
      playwrightBrowsers = pkgs.playwright-driver.browsers-chromium;
      playwrightEnv = {
        PLAYWRIGHT_BROWSERS_PATH = "${playwrightBrowsers}";
        PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
      };

      version = (lib.importJSON ./packages/cli/package.json).version;

      src = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./package.json
          ./pnpm-lock.yaml
          ./pnpm-workspace.yaml
          ./tsconfig.base.json
          ./vitest.config.ts
          ./packages
        ];
      };
    in
    {
      packages.${system}.default = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = "webscoop";
        inherit version src;

        pnpmDeps = pkgs.fetchPnpmDeps {
          inherit (finalAttrs) pname version src;
          inherit pnpm;
          fetcherVersion = 3;
          hash = "sha256-HEe5pSYvXGWFFubBC9azbdqKWTqN3U054qmfmZesd44=";
        };

        nativeBuildInputs = [
          nodejs
          pnpm
          pkgs.pnpmConfigHook
          pkgs.makeWrapper
        ];

        env = playwrightEnv;

        preBuild = ''
          # pnpm 11 verifies node_modules before every `pnpm run`, which the
          # offline install from pnpmConfigHook does not satisfy.
          echo 'verifyDepsBeforeRun: false' >> pnpm-workspace.yaml
        '';

        buildPhase = ''
          runHook preBuild
          pnpm --filter @webscoop/cli build
          runHook postBuild
        '';

        # Unit tests only; browser integration tests skip without a display.
        doCheck = true;
        checkPhase = ''
          runHook preCheck
          pnpm test
          runHook postCheck
        '';

        installPhase = ''
          runHook preInstall

          lib=$out/lib/webscoop
          mkdir -p $lib/node_modules $out/bin
          cp -r packages/cli/dist $lib/dist

          # The bundle keeps Playwright external; ship it next to the bundle.
          playwright=$(realpath packages/cli/node_modules/playwright)
          cp -rL "$playwright" $lib/node_modules/playwright
          cp -rL "$(dirname "$playwright")/playwright-core" $lib/node_modules/playwright-core

          makeWrapper ${lib.getExe nodejs} $out/bin/webscoop \
            --add-flags $lib/dist/webscoop.js \
            ${lib.concatStringsSep " " (
              lib.mapAttrsToList (name: value: "--set-default ${name} ${lib.escapeShellArg value}") playwrightEnv
            )}

          runHook postInstall
        '';

        meta = {
          description = "Record scrapers by clicking, run them unattended from the command line";
          license = lib.licenses.mit;
          mainProgram = "webscoop";
          platforms = [ system ];
        };
      });

      apps.${system}.default = {
        type = "app";
        program = lib.getExe self.packages.${system}.default;
      };

      devShells.${system}.default = pkgs.mkShell (
        playwrightEnv
        // {
          packages = [
            nodejs
            pnpm
          ];
          shellHook = ''
            echo "webscoop dev shell: node $(node --version), pnpm $(pnpm --version), Chromium from $PLAYWRIGHT_BROWSERS_PATH"
          '';
        }
      );
    };
}
