# tarex-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _tarex_user_zdotdir="${TAREX_USER_ZDOTDIR:-$HOME}"
  [ -f "$_tarex_user_zdotdir/.zprofile" ] && source "$_tarex_user_zdotdir/.zprofile"
  unset _tarex_user_zdotdir
}
:
