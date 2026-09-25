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
          ./README.md
          ./package-lock.json
          ./tsconfig.base.json
          ./vitest.config.ts
          ./packages
        ];
      };
    in
    {
      packages.${system}.default = pkgs.stdenv.mkDerivation {
        pname = "webscoop";
        inherit version src;

        npmDeps = pkgs.fetchNpmDeps {
          inherit src;
          fetcherVersion = 2;
          hash = "sha256-6pe+rrl+/v7I1PMIcDbk54ziHYH22s9wZIlHypYGmB0=";
        };

        nativeBuildInputs = [
          nodejs
          pkgs.npmHooks.npmConfigHook
          pkgs.makeWrapper
        ];

        env = playwrightEnv // {
          NIX_NPM_FETCHER_VERSION = "2";
        };

        buildPhase = ''
          runHook preBuild
          # Workspaces build in dependency order; the CLI embeds the recorder bundle.
          npm run build
          runHook postBuild
        '';

        # Unit tests only; browser integration tests skip without a display.
        doCheck = true;
        checkPhase = ''
          runHook preCheck
          npm test
          runHook postCheck
        '';

        installPhase = ''
          runHook preInstall

          lib=$out/lib/webscoop
          mkdir -p $lib/node_modules $out/bin
          cp -r packages/cli/dist $lib/dist

          # The bundle keeps Playwright external; ship it next to the bundle.
          cp -rL node_modules/playwright $lib/node_modules/playwright
          cp -rL node_modules/playwright-core $lib/node_modules/playwright-core

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
      };

      apps.${system}.default = {
        type = "app";
        program = lib.getExe self.packages.${system}.default;
      };

      devShells.${system}.default = pkgs.mkShell (
        playwrightEnv
        // {
          packages = [ nodejs ];
          shellHook = ''
            echo "webscoop dev shell: node $(node --version), npm $(npm --version), Chromium from $PLAYWRIGHT_BROWSERS_PATH"
          '';
        }
      );
    };
}
