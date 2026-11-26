# Publish the current commit to the public repository as a curated tree.
#   zsh scripts/publish_public.zsh "commit message"          # commit in the public clone only
#   zsh scripts/publish_public.zsh "commit message" --push   # and push it
# The private checkout never pushes (its history holds artwork that may not be
# redistributed); only this export goes out, after scripts/check_public_tree.py passes.
set -eu
root=$(git rev-parse --show-toplevel); cd "$root"
message="${1:?commit message}"; push="${2:-}"
[[ -z $(git status --porcelain) ]] || { echo 'Commit or stash local changes first.'; exit 1; }
pub="$root/.local/public-repo"
[[ -d "$pub/.git" ]] || git clone -q git@github.com:sairaisaika/dsh_stackcahn.git "$pub"
git -C "$pub" config user.name sairaisaika
git -C "$pub" config user.email 46681074+sairaisaika@users.noreply.github.com
git -C "$pub" pull -q --ff-only
find "$pub" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git archive HEAD | tar -x -C "$pub"
rm -f "$pub"/firmware/whale-sources/*.(jpg|jpeg|png|webp)(N) \
      "$pub/firmware/agent/whale_assets.bin" "$pub/wiki/assets/whale-avatar-preview.png"
# The voice lock's header names the local Python path; the private copy keeps its exact bytes
# (the installed voice environment fingerprints this file), the public copy shows ~ instead.
sed -i '' "s#$HOME/#~/#g" "$pub/vendor/voice/requirements-macos-arm64.lock"
python3 scripts/check_public_tree.py "$pub" --deny .local/public-deny.txt
git -C "$pub" add -A
if git -C "$pub" diff --cached --quiet; then echo 'Public tree already matches; nothing to commit.'; exit 0; fi
git -C "$pub" commit -q -F - <<MSG
$message

Exported from the private checkout at $(git rev-parse --short HEAD).
MSG
git -C "$pub" log --oneline -1
if [[ "$push" == --push ]]; then git -C "$pub" push -q origin HEAD:main && echo 'Pushed to github.com/sairaisaika/dsh_stackcahn.'
else echo 'Committed in the public clone only; rerun with --push to publish.'; fi
