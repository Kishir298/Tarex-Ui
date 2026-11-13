# tarex-shell-integration (fish)
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D so the host tracks cwd and prompt
# boundaries without re-parsing the prompt. fish 4.0+ writes its own OSC 133
# A/B (the `mark-prompt` feature); Tarex disables it at spawn via
# fish_features=no-mark-prompt so these markers aren't emitted twice.

# Installed into conf.d, which every fish session sources; only Tarex-spawned
# shells (TAREX_TERMINAL=1) may get their prompt wrapped.
if not set -q TAREX_TERMINAL
    exit 0
end
if set -q __TAREX_HOOKS_LOADED
    exit 0
end
set -g __TAREX_HOOKS_LOADED 1

if set -q TAREX_CLI; and test -x "$TAREX_CLI"
    function tarex
        command "$TAREX_CLI" $argv
    end
end

# Tarex is a clean terminal; drop fish's default startup greeting. A user who
# sets their own in config.fish (sourced after this) keeps it.
function fish_greeting
end

set -g __TAREX_HOST (uname -n 2>/dev/null; or echo localhost)

# URL-encode a path keeping `/` intact so it stays valid inside file://.
function __tarex_urlencode_path
    set -l parts (string split '/' -- $argv[1])
    set -l out
    for p in $parts
        if test -n "$p"
            set out $out (string escape --style=url -- $p)
        else
            set out $out ""
        end
    end
    string join '/' $out
end

function __tarex_restore_status
    return $argv[1]
end

function __tarex_capture_user_prompt
    if not functions -q fish_prompt
        return
    end
    if functions fish_prompt | string match -q '*__tarex_user_prompt*'
        return
    end
    functions -e __tarex_user_prompt 2>/dev/null
    functions -c fish_prompt __tarex_user_prompt
end

# Wrapped so `fish -C __tarex_install_prompt` can re-run it AFTER config.fish,
# where a framework prompt (starship etc.) would otherwise override fish_prompt
# and drop our markers.
function __tarex_install_prompt
    # ponytail: cover Conda's named wrapper; generalize if another prompt
    # framework preserves Tarex indirectly.
    if not set -q TAREX_BLOCKS
        and functions -q __fish_prompt_orig
        and functions fish_prompt | string match -q '*__fish_prompt_orig*'
        and functions __fish_prompt_orig | string match -q '*__tarex_user_prompt*'
        return
    end
    __tarex_capture_user_prompt
    function fish_prompt
        set -l __tarex_status $status
        printf '\e]133;D;%d\e\\' $__tarex_status
        printf '\e]7;file://%s%s\e\\' "$__TAREX_HOST" (__tarex_urlencode_path "$PWD")
        printf '\e]133;A\e\\'
        # Reserve block spacing without replacing the user's prompt.
        if set -q TAREX_BLOCKS
            if set -q __tarex_block_seen
                printf '\n\n'
            else
                printf '\n'
            end
        end
        __tarex_restore_status $__tarex_status
        if functions -q __tarex_user_prompt
            __tarex_user_prompt
        else
            printf '%s > ' (prompt_pwd)
        end
        printf '\e]133;B\e\\'
    end
end
__tarex_install_prompt

function __tarex_preexec --on-event fish_preexec
    set -g __tarex_block_seen 1
    set -l cmd (string replace -ra '[\x00-\x1f\x7f]' ' ' -- "$argv")
    printf '\e]133;C;%s\e\\' (string sub -l 256 -- "$cmd")
end
