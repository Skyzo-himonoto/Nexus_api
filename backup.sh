#!/data/data/com.termux/files/usr/bin/bash
DATE=$(date +"%Y%m%d_%H%M%S")
BACKUP_DIR="/data/data/com.termux/files/home/nexus-api/backups"

# Backup database
cp "$BACKUP_DIR/../database/nexus.db" "$BACKUP_DIR/nexus_$DATE.db" 2>/dev/null

# Backup source code ke GitHub
cd /data/data/com.termux/files/home/nexus-api
git add .
git commit -m "Auto backup: $DATE"
git push origin main --quiet

# Hapus backup lama (lebih dari 7 hari)
find "$BACKUP_DIR" -name "*.db" -mtime +7 -delete 2>/dev/null

echo "Backup completed: $DATE" >> "$BACKUP_DIR/backup.log"
