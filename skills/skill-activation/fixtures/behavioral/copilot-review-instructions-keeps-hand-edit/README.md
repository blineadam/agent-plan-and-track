# ledger

A small command-line tool that totals CSV expense exports by category.

## Usage

```
python -m ledger totals expenses.csv
python -m ledger totals --month 2026-09 expenses.csv
```

## Layout

- `src/ledger/cli.py`: argument parsing and the `totals` command.
- `src/ledger/totals.py`: the summing logic, kept free of I/O.
