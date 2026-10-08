# Home-manager module: programs.webscoop.
{ self }:
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.webscoop;
  inherit (lib) mkEnableOption mkOption mkIf types;
  system = pkgs.stdenv.hostPlatform.system;
  json = pkgs.formats.json { };

  binOnly =
    if cfg.shellCompletions.enable then cfg.package
    else pkgs.symlinkJoin {
      name = "webscoop-bin-only";
      paths = [ cfg.package ];
      postBuild = "find $out -mindepth 1 -maxdepth 1 ! -name bin -exec rm -rf {} +";
    };

  # Every job of the daemon inherits the submitting command's environment,
  # so wrapping the binary covers the daemon too.
  cliPackage =
    if cfg.environment == { } then binOnly
    else pkgs.symlinkJoin {
      name = "webscoop-wrapped";
      paths = [ binOnly ];
      nativeBuildInputs = [ pkgs.makeWrapper ];
      postBuild = ''
        wrapProgram $out/bin/webscoop ${lib.concatStringsSep " " (
          lib.mapAttrsToList (k: v: "--set ${lib.escapeShellArg k} ${lib.escapeShellArg v}") cfg.environment
        )}
      '';
    };

  # Drop nulls, then attribute sets left empty, so webscoop applies its defaults.
  clean =
    v:
    if builtins.isAttrs v then
      lib.filterAttrs (_: x: x != null && x != { }) (lib.mapAttrs (_: clean) v)
    else if builtins.isList v then map clean v
    else v;
  settings = clean cfg.settings;

  nullable = type: description: mkOption {
    type = types.nullOr type;
    default = null;
    inherit description;
  };
in
{
  options.programs.webscoop = {
    enable = mkEnableOption "webscoop, a scraper recorder and runner";
    package = mkOption {
      type = types.package;
      default = self.packages.${system}.webscoop;
      description = "Package providing bin/webscoop.";
    };
    shellCompletions.enable = mkOption {
      type = types.bool;
      default = true;
      description = "Install the zsh completion.";
    };
    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = { NODE_EXTRA_CA_CERTS = "/etc/ssl/local-ca.pem"; };
      description = "Variables set for every webscoop invocation by wrapping the binary.";
    };
    settings = mkOption {
      type = types.submodule {
        freeformType = json.type;
        options.daemon = {
          concurrency = {
            total = nullable types.ints.positive "Maximum jobs the daemon runs at once.";
            perRecipe = nullable types.ints.positive "Maximum jobs per recipe.";
            recipes = nullable (types.attrsOf types.ints.positive) "Per-recipe job limits, by recipe name.";
          };
          idleMs = nullable types.ints.unsigned "Milliseconds the daemon waits idle before exiting.";
        };
      };
      default = { };
      description = "Written as JSON to $XDG_CONFIG_HOME/webscoop/config.json; option paths match JSON paths.";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = !(cfg.environment ? WEBSCOOP_HOME) || settings == { };
        message = "programs.webscoop.settings is written to $XDG_CONFIG_HOME/webscoop/config.json, but programs.webscoop.environment.WEBSCOOP_HOME makes webscoop read $WEBSCOOP_HOME/config.json instead; unset one of them.";
      }
    ];

    home.packages = [ cliPackage ];

    xdg.configFile."webscoop/config.json" = mkIf (settings != { }) {
      source = json.generate "webscoop-config.json" settings;
    };
  };
}
