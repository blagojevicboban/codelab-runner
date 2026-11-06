#!/usr/bin/env bash
# Create the MariaDB user of the CodeLab runner (run as root on the runner's server). It may create, use and drop only
# the databases and users of sessions, named cl_..., so it cannot touch other databases on the same server.
#   sudo bash deploy/mariadb-admin.sh <password>
set -euo pipefail
PASSWORD="${1:?password}"
sed "s/@@PASSWORD@@/${PASSWORD}/" <<'SQL' | mariadb
CREATE USER IF NOT EXISTS 'codelab_admin'@'localhost' IDENTIFIED BY '@@PASSWORD@@';
ALTER USER 'codelab_admin'@'localhost' IDENTIFIED BY '@@PASSWORD@@';
GRANT CREATE USER ON *.* TO 'codelab_admin'@'localhost';
GRANT ALL PRIVILEGES ON `cl_%`.* TO 'codelab_admin'@'localhost' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SHOW GRANTS FOR 'codelab_admin'@'localhost';
SQL
