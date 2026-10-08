# `nix flake check` gate: home-manager evaluations of the module.
{ self, pkgs, home-manager }:
let
  home = { username = "test"; homeDirectory = "/home/test"; stateVersion = "25.05"; };
  hmConfig = programs: home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      self.homeManagerModules.webscoop
      { inherit home; programs.webscoop = programs; }
    ];
  };

  full = hmConfig {
    enable = true;
    environment.FOO = "bar";
    settings = {
      browser.driver = "patchright";
      daemon.concurrency = { total = 3; perRecipe = 1; };
    };
  };
  empty = hmConfig { enable = true; };
in
{
  hm-module-eval = pkgs.runCommand "hm-module-eval" { nativeBuildInputs = [ pkgs.jq ]; } ''
    gen=${full.activationPackage}
    cfg=$gen/home-files/.config/webscoop/config.json
    jq -e '.daemon.concurrency.total == 3' $cfg
    jq -e '.daemon.concurrency.perRecipe == 1' $cfg
    jq -e '.daemon.concurrency | has("recipes") | not' $cfg
    jq -e '.daemon | has("idleMs") | not' $cfg
    jq -e '.browser.driver == "patchright"' $cfg
    grep -q FOO $gen/home-path/bin/webscoop
    touch $out
  '';

  hm-module-empty-settings = pkgs.runCommand "hm-module-empty-settings" { } ''
    gen=${empty.activationPackage}
    test ! -e $gen/home-files/.config/webscoop/config.json
    test -x $gen/home-path/bin/webscoop
    touch $out
  '';
}
