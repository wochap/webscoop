{
  description = "webscoop: record scrapers by clicking, run them unattended from the command line";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?rev=0ad6f47ea4fe188f4bc8f0380f93ae8523337c6c"; # nixos-26.05 (10 jul 2026)
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self, nixpkgs, home-manager }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = nixpkgs.lib;

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
          ./skills
        ];
      };

      webscoopFor = p: p.callPackage ./nix/package.nix { inherit src version; };
    in
    {
      packages = forAllSystems (
        system:
        let
          webscoop = webscoopFor nixpkgs.legacyPackages.${system};
        in
        {
          inherit webscoop;
          default = webscoop;
        }
      );

      overlays.default = final: prev: { webscoop = webscoopFor final; };

      homeManagerModules.webscoop = import ./nix/hm-module.nix { inherit self; };
      homeManagerModules.default = self.homeManagerModules.webscoop;

      checks = forAllSystems (
        system:
        import ./nix/checks.nix {
          inherit self home-manager;
          pkgs = nixpkgs.legacyPackages.${system};
        }
      );

      apps.${system}.default = {
        type = "app";
        program = lib.getExe self.packages.${system}.default;
      };

      devShells.${system}.default = pkgs.mkShell (
        self.packages.${system}.default.playwrightEnv
        // {
          packages = [ pkgs.nodejs_22 ];
          shellHook = ''
            echo "webscoop dev shell: node $(node --version), npm $(npm --version), Chromium from $PLAYWRIGHT_BROWSERS_PATH"
          '';
        }
      );
    };
}
