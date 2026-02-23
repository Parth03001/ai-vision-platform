"""
connectors package
~~~~~~~~~~~~~~~~~~
Database connectivity layer:

* :mod:`.table_creation`    — SQLAlchemy Core table definitions (PostgreSQL)
* :mod:`.statedb_connector` — Synchronous connection pool wrapper
* :mod:`.statedb_manager`   — High-level DB initialisation manager
"""

from .statedb_connector import StateDBConnector
from .statedb_manager import StateDBManager

__all__ = ["StateDBConnector", "StateDBManager"]
