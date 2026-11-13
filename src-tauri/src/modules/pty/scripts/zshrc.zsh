# tarex-shell-integration (zshrc)
#
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D (prompt-start / prompt-end / pre-exec /
# command-done-with-exit-code) so the host can detect command boundaries and
# track cwd without re-parsing the prompt. `status` is a read-only special in
# zsh, so we shadow $? into `_tarex_ret`.

{
  _tarex_user_zdotdir="${TAREX_USER_ZDOTDIR:-$HOME}"
  [ -f "$_tarex_user_zdotdir/.zshrc" ] && source "$_tarex_user_zdotdir/.zshrc"
  unset _tarex_user_zdotdir
}

if [[ -n "$TAREX_CLI" && -x "$TAREX_CLI" ]]; then
  tarex() {
    command "$TAREX_CLI" "$@"
  }
fi

# Re-source guard within a single shell (e.g. user runs `source ~/.zshrc`).
# This is NOT exported, so each nested zsh installs its own hooks — desired,
# since every interactive shell needs its own prompt integration.
if [[ -z "$__TAREX_HOOKS_LOADED" ]]; then
  __TAREX_HOOKS_LOADED=1
  autoload -Uz add-zsh-hook 2>/dev/null

  # URL-encode $PWD byte-wise so multi-byte paths stay valid in the `file://`
  # URI emitted via OSC 7. `no_multibyte` forces ${s[i]} to index bytes (not
  # code points), and LC_ALL=C keeps the [a-zA-Z0-9...] class single-byte.
  _tarex_urlencode() {
    emulate -L zsh
    setopt localoptions no_multibyte
    local LC_ALL=C s="$1" i byte
    for (( i=1; i<=${#s}; i++ )); do
      byte="${s[i]}"
      case "$byte" in
        [a-zA-Z0-9/._~-]) printf '%s' "$byte" ;;
        *) printf '%%%02X' "'$byte" ;;
      esac
    done
  }

  _tarex_precmd() {
    local _tarex_ret=$?
    printf '\e]133;D;%s\e\\' "$_tarex_ret"
    printf '\e]7;file://%s%s\e\\' "${HOST}" "$(_tarex_urlencode "$PWD")"
    # Keep header spacing while readline owns the visible prompt and input.
    if [[ -n "$TAREX_BLOCKS" ]]; then
      if [[ -n "$_tarex_block_seen" ]]; then
        printf '\n\n'
      else
        printf '\n'
      fi
    fi
    if [[ "$PS1" != *$'\e]133;B\e\\'* ]]; then
      PS1="$PS1"$'%{\e]133;B\e\\%}'
    fi
    printf '\e]133;A\e\\'
  }

  _tarex_preexec() {
    # Mark that a real command ran, so the next prompt switches from one blank
    # row (first prompt, no block above) to two (end gap + header row).
    [[ -n "$TAREX_BLOCKS" ]] && _tarex_block_seen=1
    local cmd="${1//[[:cntrl:]]/ }"
    printf '\e]133;C;%s\e\\' "${cmd[1,256]}"
  }

  if (( $+functions[add-zsh-hook] )); then
    add-zsh-hook precmd _tarex_precmd
    add-zsh-hook preexec _tarex_preexec
  fi

  # Warp/iTerm2-style word-end navigation: zsh's default `forward-word` (M-f /
  # Option+Right) overshoots to the START of the next word; `emacs-forward-word`
  # stops at the END of the current word, which is what nearly every other shell
  # and GUI editor does. Only rebind when the binding is still the stock zsh
  # default — respects any explicit remap in the user's .zshrc.
  if (( $+widgets[emacs-forward-word] )) \
     && [[ "$(bindkey '\ef')" == '"^[f" forward-word' ]]; then
    bindkey '\ef' emacs-forward-word
  fi

  _tarex_precmd
fi
:
