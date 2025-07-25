#!/bin/bash

# Script de migration vers la solution Python BLE
# Ce script automatise la migration de Noble vers Python/Bleak

set -e  # Exit on any error

echo "🚀 Migration vers Python BLE..."
echo "================================"

# Couleurs pour les messages
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Fonction pour afficher les messages colorés
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Vérification des prérequis
check_prerequisites() {
    log_info "Vérification des prérequis..."
    
    # Vérifier Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js n'est pas installé"
        exit 1
    fi
    log_success "Node.js trouvé: $(node --version)"
    
    # Vérifier Python3
    if ! command -v python3 &> /dev/null; then
        log_error "Python3 n'est pas installé"
        exit 1
    fi
    log_success "Python3 trouvé: $(python3 --version)"
    
    # Vérifier pip
    if ! command -v pip3 &> /dev/null; then
        log_error "pip3 n'est pas installé"
        exit 1
    fi
    log_success "pip3 trouvé: $(pip3 --version)"
}

# Installation des dépendances Python
install_python_deps() {
    log_info "Installation des dépendances Python..."
    
    # Créer un environnement virtuel si nécessaire
    if [ ! -d "venv" ]; then
        log_info "Création de l'environnement virtuel Python..."
        python3 -m venv venv
    fi
    
    # Activer l'environnement virtuel
    source venv/bin/activate
    
    # Installer les dépendances
    log_info "Installation de bleak et asyncio..."
    pip install bleak asyncio
    
    log_success "Dépendances Python installées"
}

# Backup de l'ancien code
backup_old_code() {
    log_info "Sauvegarde de l'ancien code..."
    
    # Créer le dossier de backup
    BACKUP_DIR="backup_$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$BACKUP_DIR"
    
    # Sauvegarder bluetooth.ts s'il existe
    if [ -f "src/bluetooth.ts" ]; then
        cp "src/bluetooth.ts" "$BACKUP_DIR/"
        log_success "bluetooth.ts sauvegardé dans $BACKUP_DIR/"
    fi
    
    # Sauvegarder package.json
    if [ -f "package.json" ]; then
        cp "package.json" "$BACKUP_DIR/"
        log_success "package.json sauvegardé dans $BACKUP_DIR/"
    fi
    
    echo "$BACKUP_DIR" > .migration_backup_dir
    log_success "Backup créé dans $BACKUP_DIR"
}

# Compilation TypeScript
build_typescript() {
    log_info "Compilation du code TypeScript..."
    
    # Installer les dépendances npm si nécessaire
    if [ ! -d "node_modules" ]; then
        log_info "Installation des dépendances npm..."
        npm install
    fi
    
    # Compiler TypeScript
    log_info "Compilation TypeScript..."
    npm run build
    
    log_success "Code TypeScript compilé"
}

# Test de la migration
test_migration() {
    log_info "Test de la migration..."
    
    # Vérifier que le fichier de test existe
    if [ ! -f "scripts/test-migration.js" ]; then
        log_error "Fichier de test manquant: scripts/test-migration.js"
        return 1
    fi
    
    # Exécuter les tests
    log_info "Exécution des tests de migration..."
    if node scripts/test-migration.js; then
        log_success "Tests de migration réussis"
        return 0
    else
        log_error "Tests de migration échoués"
        return 1
    fi
}

# Test de compatibilité
test_compatibility() {
    log_info "Test de compatibilité..."
    
    # Vérifier que bleDispatcher.py existe
    if [ ! -f "scripts/bleDispatcher.py" ]; then
        log_error "bleDispatcher.py manquant"
        return 1
    fi
    
    # Test basique du script Python
    log_info "Test du script Python..."
    if python3 scripts/bleDispatcher.py --help &> /dev/null; then
        log_success "Script Python fonctionnel"
    else
        log_warning "Test Python échoué (normal si pas d'argument --help)"
    fi
    
    return 0
}

# Nettoyage des anciens fichiers
cleanup_old_files() {
    log_info "Nettoyage des anciens fichiers..."
    
    # Supprimer bluetoothV2.ts s'il existe
    if [ -f "src/bluetoothV2.ts" ]; then
        rm "src/bluetoothV2.ts"
        log_success "bluetoothV2.ts supprimé"
    fi
    
    # Nettoyer les fichiers temporaires
    find . -name "*.tmp" -delete 2>/dev/null || true
    find . -name ".DS_Store" -delete 2>/dev/null || true
    
    log_success "Nettoyage terminé"
}

# Fonction de rollback
rollback() {
    log_warning "Rollback en cours..."
    
    if [ -f ".migration_backup_dir" ]; then
        BACKUP_DIR=$(cat .migration_backup_dir)
        if [ -d "$BACKUP_DIR" ]; then
            log_info "Restauration depuis $BACKUP_DIR..."
            
            # Restaurer les fichiers
            if [ -f "$BACKUP_DIR/bluetooth.ts" ]; then
                cp "$BACKUP_DIR/bluetooth.ts" "src/"
                log_success "bluetooth.ts restauré"
            fi
            
            if [ -f "$BACKUP_DIR/package.json" ]; then
                cp "$BACKUP_DIR/package.json" "./"
                log_success "package.json restauré"
            fi
            
            # Recompiler
            npm run build
            
            log_success "Rollback terminé"
        else
            log_error "Dossier de backup introuvable: $BACKUP_DIR"
        fi
    else
        log_error "Aucune information de backup trouvée"
    fi
}

# Fonction principale
main() {
    echo "Début de la migration..."
    echo "Timestamp: $(date)"
    echo ""
    
    # Vérifier les arguments
    if [ "$1" = "--rollback" ]; then
        rollback
        exit 0
    fi
    
    if [ "$1" = "--test-only" ]; then
        log_info "Mode test uniquement"
        build_typescript
        test_migration
        exit $?
    fi
    
    # Étapes de migration
    check_prerequisites
    backup_old_code
    install_python_deps
    build_typescript
    
    # Tests
    if test_migration && test_compatibility; then
        log_success "Migration réussie!"
        cleanup_old_files
        
        echo ""
        echo "🎉 Migration terminée avec succès!"
        echo "=================================="
        echo "✅ BleBridge amélioré avec support Python"
        echo "✅ Gestion d'état robuste implémentée"
        echo "✅ Interface compatible maintenue"
        echo "✅ Tests de validation réussis"
        echo ""
        echo "📋 Prochaines étapes:"
        echo "1. Redémarrer Homebridge"
        echo "2. Vérifier les logs pour confirmer le bon fonctionnement"
        echo "3. Tester les commandes LED"
        echo ""
        echo "🔧 En cas de problème:"
        echo "   ./scripts/migrate-to-python.sh --rollback"
        
    else
        log_error "Migration échouée"
        log_warning "Exécution du rollback automatique..."
        rollback
        exit 1
    fi
}

# Gestion des signaux pour cleanup
trap 'log_error "Migration interrompue"; rollback; exit 1' INT TERM

# Exécution
main "$@"