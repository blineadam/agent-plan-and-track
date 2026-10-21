def format_cents(amount_cents):
    """Return amount_cents as a display string such as "$12.05"."""
    dollars, cents = divmod(amount_cents, 100)
    return f"${dollars}.{cents:02d}"
