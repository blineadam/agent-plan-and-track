# Usage

Pass one expression as a single argument:

    python3 cli.py "7 - 2"

Only non-negative integers and the operators `+ - * /` are supported, and
division rounds down.

## Operator precedence

`*` and `/` bind tighter than `+` and `-`, and operators of equal precedence
group left to right, so `8 - 3 - 1` is `4`.
