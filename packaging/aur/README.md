# AUR package (not published)

`PKGBUILD` builds DocProc4 from the tagged source on GitHub and installs it as an
Arch package (`docproc4`). It's kept here, ready, in case DocProc4 is ever
published to the AUR.

## Install it on your own machine (no publishing needed)

This builds the currently tagged version from GitHub. The tag (`v$pkgver`) has to exist,
which happens when a release is published. While the repository is private,
your own GitHub login (set up by `gh auth login`) is what lets it download.

```bash
cd packaging/aur
makepkg -si
```

`-s` installs any missing build tools and `-i` installs the finished package.
Remove it later with `sudo pacman -R docproc4`.

## Publishing to the AUR (if you decide to)

1. Make the GitHub repository public (Settings → General → Danger Zone →
   Change visibility). The `LICENSE` file (AGPL-3.0) is already in place.
2. Publish a GitHub release for the version in the PKGBUILD, so the tag
   `v0.1.0` (etc.) exists.
3. Create an account at https://aur.archlinux.org and add an SSH public key
   under My Account.
4. Regenerate the metadata file and push both files to the AUR:

   ```bash
   makepkg --printsrcinfo > .SRCINFO
   git clone ssh://aur@aur.archlinux.org/docproc4.git aur-docproc4
   cp PKGBUILD .SRCINFO aur-docproc4/
   cd aur-docproc4 && git add PKGBUILD .SRCINFO && git commit -m "Initial upload: 0.1.0" && git push
   ```

## Each new release

Set `pkgver` to the new version, reset `pkgrel=1`, regenerate `.SRCINFO`, and
push to the AUR repository again. If only the packaging changes (same app
version), bump `pkgrel` instead.

## Maintainer duties

Answer comments on the package's AUR page, and keep it building when Rust,
Node, or WebKitGTK update. If you stop maintaining it, "disown" it on the AUR
so someone else can adopt it.
