class ShipcalcError(Exception):
    """Base class for every error shipcalc raises."""


class UnknownZone(ShipcalcError):
    """Raised when a destination zone has no rate."""


class Overweight(ShipcalcError):
    """Raised when a parcel exceeds the carrier's weight limit."""
