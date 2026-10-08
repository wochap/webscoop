# The webscoop CLI: npm workspaces build, wrapped with Node and nixpkgs' Chromium.
{
  lib,
  stdenv,
  nodejs_22,
  playwright-driver,
  fetchNpmDeps,
  npmHooks,
  makeWrapper,
  installShellFiles,
  src,
  version,
}:
let
  nodejs = nodejs_22;
  # nixpkgs' playwright-driver must match the `playwright` version pinned in
  # package.json, so Playwright finds its Chromium build in the Nix store.
  playwrightEnv = {
    PLAYWRIGHT_BROWSERS_PATH = "${playwright-driver.browsers-chromium}";
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
  };
in
stdenv.mkDerivation {
  pname = "webscoop";
  inherit version src;

  npmDeps = fetchNpmDeps {
    inherit src;
    fetcherVersion = 2;
    hash = "sha256-76+im8YgqQYMa4rZq8QNoegd18SlWbzpJ6ph6NGV0jA=";
  };

  nativeBuildInputs = [
    nodejs
    npmHooks.npmConfigHook
    makeWrapper
    installShellFiles
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
  doCheck = false;
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

    # The bundle keeps Playwright and Patchright external; ship them next to the bundle.
    # Patchright's `chrome` channel uses the system Chrome, so no browser is downloaded.
    cp -rL node_modules/playwright $lib/node_modules/playwright
    cp -rL node_modules/playwright-core $lib/node_modules/playwright-core
    cp -rL node_modules/patchright $lib/node_modules/patchright
    cp -rL node_modules/patchright-core $lib/node_modules/patchright-core

    makeWrapper ${lib.getExe nodejs} $out/bin/webscoop \
      --add-flags $lib/dist/webscoop.js \
      ${lib.concatStringsSep " " (
        lib.mapAttrsToList (name: value: "--set-default ${name} ${lib.escapeShellArg value}") playwrightEnv
      )}

    installShellCompletion --zsh packages/cli/completions/_webscoop

    mkdir -p $out/share/webscoop/skills
    cp -r skills/webscoop-use-recipe $out/share/webscoop/skills/

    runHook postInstall
  '';

  passthru = { inherit playwrightEnv; };

  meta = {
    description = "Record scrapers by clicking, run them unattended from the command line";
    license = lib.licenses.mit;
    mainProgram = "webscoop";
    platforms = lib.platforms.linux;
  };
}
