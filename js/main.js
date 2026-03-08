/**
 * pxf Proxy Importer - Main Panel Logic
 * Watches a folder for proxy files, shows thumbnails, imports into Premiere Pro.
 */

(function () {
    'use strict';

    const csInterface = new CSInterface();
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { execFile } = require('child_process');

    const FFMPEG_PATH = '/opt/homebrew/bin/ffmpeg';

    // Video extensions to watch for
    const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4', '.m4v', '.mxf', '.avi']);

    // State
    let files = [];           // Array of { path, name, size, mtime, thumbnailUrl, selected, imported }
    let watcher = null;       // fs.watch instance
    let debounceTimers = {};  // path -> timeout for debouncing fs.watch events
    let lastClickIndex = -1;  // For shift-click range selection

    // DOM refs
    const fileGrid = document.getElementById('fileGrid');
    const emptyState = document.getElementById('emptyState');
    const btnSettings = document.getElementById('btnSettings');
    const settingsPanel = document.getElementById('settingsPanel');
    const folderPathInput = document.getElementById('folderPath');
    const btnBrowse = document.getElementById('btnBrowse');
    const btnImport = document.getElementById('btnImport');
    const selectionCount = document.getElementById('selectionCount');
    const statusText = document.getElementById('statusText');
    const watchIndicator = document.getElementById('watchIndicator');
    const chkCreateBin = document.getElementById('chkCreateBin');
    const binNameInput = document.getElementById('binName');
    const chkAutoImport = document.getElementById('chkAutoImport');
    const toast = document.getElementById('toast');

    // ─── Initialization ───

    function init() {
        applyTheme();
        loadSettings();
        bindEvents();

        // Listen for Premiere theme changes
        csInterface.addEventListener(CSInterface.THEME_COLOR_CHANGED_EVENT, applyTheme);

        // Start watching if we have a saved folder
        const savedFolder = localStorage.getItem('pxf_watchFolder');
        if (savedFolder && folderExists(savedFolder)) {
            folderPathInput.value = savedFolder;
            startWatching(savedFolder);
        }
    }

    function applyTheme() {
        try {
            const skinInfo = csInterface.getHostEnvironment().appSkinInfo;
            const bg = skinInfo.panelBackgroundColor.color;
            const bgColor = rgbToHex(bg.red, bg.green, bg.blue);
            document.body.style.background = bgColor;

            // Adjust text brightness based on background
            const brightness = (bg.red * 299 + bg.green * 587 + bg.blue * 114) / 1000;
            document.body.style.color = brightness > 128 ? '#333' : '#d6d6d6';
        } catch (e) {
            // Outside Premiere, keep defaults
        }
    }

    function rgbToHex(r, g, b) {
        return '#' + [r, g, b].map(function (c) {
            var hex = Math.round(c).toString(16);
            return hex.length === 1 ? '0' + hex : hex;
        }).join('');
    }

    // ─── Settings ───

    function loadSettings() {
        chkCreateBin.checked = localStorage.getItem('pxf_createBin') === 'true';
        binNameInput.value = localStorage.getItem('pxf_binName') || 'pxf Proxies';
        chkAutoImport.checked = localStorage.getItem('pxf_autoImport') === 'true';
    }

    function saveSettings() {
        localStorage.setItem('pxf_watchFolder', folderPathInput.value);
        localStorage.setItem('pxf_createBin', chkCreateBin.checked);
        localStorage.setItem('pxf_binName', binNameInput.value);
        localStorage.setItem('pxf_autoImport', chkAutoImport.checked);
    }

    // ─── Events ───

    function bindEvents() {
        btnSettings.addEventListener('click', function () {
            settingsPanel.classList.toggle('open');
        });

        btnBrowse.addEventListener('click', function () {
            var currentPath = folderPathInput.value || '';
            csInterface.evalScript('selectFolder("' + escapeForScript(currentPath) + '")', function (result) {
                if (result && result !== '' && result !== 'undefined') {
                    folderPathInput.value = result;
                    saveSettings();
                    startWatching(result);
                }
            });
        });

        folderPathInput.addEventListener('change', function () {
            var val = folderPathInput.value.trim();
            if (val && folderExists(val)) {
                saveSettings();
                startWatching(val);
            }
        });

        chkCreateBin.addEventListener('change', saveSettings);
        binNameInput.addEventListener('change', saveSettings);
        chkAutoImport.addEventListener('change', saveSettings);

        btnImport.addEventListener('click', importSelected);

        // Keyboard: Cmd+A to select all, Delete to deselect
        document.addEventListener('keydown', function (e) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
                e.preventDefault();
                selectAll();
            }
            if (e.key === 'Escape') {
                deselectAll();
            }
        });
    }

    // ─── Folder Watching ───

    function folderExists(dirPath) {
        try {
            return fs.statSync(dirPath).isDirectory();
        } catch (e) {
            return false;
        }
    }

    function startWatching(dirPath) {
        // Stop existing watcher
        if (watcher) {
            watcher.close();
            watcher = null;
        }

        if (!folderExists(dirPath)) {
            statusText.textContent = 'Folder not found';
            watchIndicator.classList.remove('active');
            return;
        }

        // Initial scan
        scanFolder(dirPath);

        // Start watching
        try {
            watcher = fs.watch(dirPath, { recursive: true }, function (eventType, filename) {
                if (!filename) return;
                var ext = path.extname(filename).toLowerCase();
                if (!VIDEO_EXTENSIONS.has(ext)) return;

                var fullPath = path.join(dirPath, filename);

                // Debounce: wait for file to finish writing
                if (debounceTimers[fullPath]) {
                    clearTimeout(debounceTimers[fullPath]);
                }
                debounceTimers[fullPath] = setTimeout(function () {
                    delete debounceTimers[fullPath];
                    handleFileEvent(fullPath);
                }, 2000);
            });

            statusText.textContent = 'Watching: ' + path.basename(dirPath);
            watchIndicator.classList.add('active');
        } catch (e) {
            statusText.textContent = 'Watch error: ' + e.message;
            watchIndicator.classList.remove('active');
        }
    }

    function scanRecursive(dirPath) {
        var entries = fs.readdirSync(dirPath);
        entries.forEach(function (name) {
            if (name.startsWith('.')) return;
            var fullPath = path.join(dirPath, name);
            try {
                var stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    scanRecursive(fullPath);
                } else if (stat.isFile()) {
                    var ext = path.extname(name).toLowerCase();
                    if (!VIDEO_EXTENSIONS.has(ext)) return;
                    files.push({
                        path: fullPath,
                        name: name,
                        size: stat.size,
                        mtime: stat.mtime.getTime(),
                        thumbnailUrl: null,
                        selected: false,
                        imported: false
                    });
                }
            } catch (e) { /* skip inaccessible */ }
        });
    }

    function scanFolder(dirPath) {
        try {
            // Preserve state from previous scan
            var prevState = {};
            files.forEach(function (f) {
                prevState[f.path] = { imported: f.imported, thumbnailUrl: f.thumbnailUrl };
            });

            files = [];
            scanRecursive(dirPath);

            // Restore preserved state
            files.forEach(function (f) {
                var prev = prevState[f.path];
                if (prev) {
                    f.imported = prev.imported;
                    f.thumbnailUrl = prev.thumbnailUrl;
                }
            });

            // Sort newest first
            files.sort(function (a, b) { return b.mtime - a.mtime; });

            renderGrid();
            generateThumbnails();
        } catch (e) {
            statusText.textContent = 'Scan error: ' + e.message;
        }
    }

    function handleFileEvent(fullPath) {
        try {
            var stat = fs.statSync(fullPath);
            if (!stat.isFile()) return;

            // Check if file size is stable (not still being written)
            setTimeout(function () {
                try {
                    var stat2 = fs.statSync(fullPath);
                    if (stat2.size !== stat.size) {
                        // Still writing, wait more
                        debounceTimers[fullPath] = setTimeout(function () {
                            delete debounceTimers[fullPath];
                            handleFileEvent(fullPath);
                        }, 2000);
                        return;
                    }

                    var name = path.basename(fullPath);

                    // Check if already in list
                    var existing = files.find(function (f) { return f.path === fullPath; });
                    if (existing) {
                        existing.size = stat2.size;
                        existing.mtime = stat2.mtime.getTime();
                    } else {
                        var newFile = {
                            path: fullPath,
                            name: name,
                            size: stat2.size,
                            mtime: stat2.mtime.getTime(),
                            thumbnailUrl: null,
                            selected: false,
                            imported: false
                        };
                        files.unshift(newFile);
                        thumbQueue.push(newFile);
                        processThumbQueue();

                        // Auto-import if enabled
                        if (chkAutoImport.checked) {
                            doImport([fullPath]);
                            newFile.imported = true;
                        }
                    }

                    files.sort(function (a, b) { return b.mtime - a.mtime; });
                    renderGrid();
                } catch (e) {
                    // File may have been deleted
                }
            }, 1000);
        } catch (e) {
            // File was deleted — remove from list
            files = files.filter(function (f) { return f.path !== fullPath; });
            renderGrid();
        }
    }

    // ─── Thumbnail Generation ───

    var thumbQueue = [];
    var thumbProcessing = false;

    function generateThumbnails() {
        files.forEach(function (file) {
            if (!file.thumbnailUrl) {
                thumbQueue.push(file);
            }
        });
        processThumbQueue();
    }

    function processThumbQueue() {
        if (thumbProcessing || thumbQueue.length === 0) return;
        thumbProcessing = true;
        var file = thumbQueue.shift();
        generateThumbnailForFile(file, function () {
            thumbProcessing = false;
            processThumbQueue();
        });
    }

    function generateThumbnailForFile(file, done) {
        var tmpFile = path.join(os.tmpdir(), 'pxf_thumb_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.jpg');

        execFile(FFMPEG_PATH, [
            '-ss', '1',
            '-i', 'file:' + file.path,
            '-frames:v', '1',
            '-update', '1',
            '-vf', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709,scale=192:-1',
            '-q:v', '5',
            '-y',
            tmpFile
        ], { timeout: 15000 }, function (err) {
            if (err) {
                file.thumbnailUrl = 'placeholder';
                updateCardThumbnail(file);
                if (done) done();
                return;
            }

            try {
                var imgData = fs.readFileSync(tmpFile);
                file.thumbnailUrl = 'data:image/jpeg;base64,' + imgData.toString('base64');
                fs.unlinkSync(tmpFile);
            } catch (e) {
                file.thumbnailUrl = 'placeholder';
            }
            updateCardThumbnail(file);
            if (done) done();
        });
    }

    function updateCardThumbnail(file) {
        var card = document.querySelector('[data-path="' + CSS.escape(file.path) + '"]');
        if (!card) return;

        var container = card.querySelector('.thumb-img, .thumb-placeholder');
        if (!container) return;

        if (file.thumbnailUrl && file.thumbnailUrl !== 'placeholder') {
            var img = document.createElement('img');
            img.className = 'thumb-img';
            img.src = file.thumbnailUrl;
            img.alt = file.name;
            container.replaceWith(img);
        }
    }

    // ─── Rendering ───

    function renderGrid() {
        fileGrid.innerHTML = '';

        if (files.length === 0) {
            fileGrid.appendChild(emptyState);
            emptyState.style.display = '';
            updateActionBar();
            return;
        }

        files.forEach(function (file, index) {
            var card = document.createElement('div');
            card.className = 'thumb-card' + (file.selected ? ' selected' : '');
            card.setAttribute('data-path', file.path);
            card.setAttribute('data-index', index);

            // Thumbnail
            if (file.thumbnailUrl && file.thumbnailUrl !== 'placeholder') {
                card.innerHTML += '<img class="thumb-img" src="' + file.thumbnailUrl + '" alt="' + escapeHtml(file.name) + '">';
            } else {
                var ext = path.extname(file.name).toLowerCase().replace('.', '').toUpperCase();
                card.innerHTML += '<div class="thumb-placeholder">' + ext + '</div>';
            }

            // Info
            card.innerHTML += '<div class="thumb-info">' +
                '<div class="thumb-name" title="' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + '</div>' +
                '<div class="thumb-meta">' + formatSize(file.size) + ' &middot; ' + formatDate(file.mtime) + '</div>' +
                '</div>';

            // Imported badge
            if (file.imported) {
                card.innerHTML += '<div class="imported-badge">Imported</div>';
            }

            // Click handler
            card.addEventListener('click', function (e) {
                handleCardClick(index, e);
            });

            // Double-click to import
            card.addEventListener('dblclick', function (e) {
                e.preventDefault();
                doImport([file.path]);
                file.imported = true;
                renderGrid();
            });

            fileGrid.appendChild(card);
        });

        updateActionBar();
    }

    function handleCardClick(index, e) {
        if (e.shiftKey && lastClickIndex >= 0) {
            // Range select
            var start = Math.min(lastClickIndex, index);
            var end = Math.max(lastClickIndex, index);
            for (var i = start; i <= end; i++) {
                files[i].selected = true;
            }
        } else if (e.metaKey || e.ctrlKey) {
            // Toggle select
            files[index].selected = !files[index].selected;
        } else {
            // Single select (deselect others)
            files.forEach(function (f) { f.selected = false; });
            files[index].selected = true;
        }

        lastClickIndex = index;
        renderGrid();
    }

    function selectAll() {
        files.forEach(function (f) { f.selected = true; });
        renderGrid();
    }

    function deselectAll() {
        files.forEach(function (f) { f.selected = false; });
        lastClickIndex = -1;
        renderGrid();
    }

    function updateActionBar() {
        var selectedFiles = files.filter(function (f) { return f.selected; });
        var count = selectedFiles.length;

        if (count === 0) {
            selectionCount.textContent = files.length + ' file' + (files.length !== 1 ? 's' : '');
            btnImport.disabled = true;
        } else {
            selectionCount.textContent = count + ' selected';
            btnImport.disabled = false;
        }
    }

    // ─── Import ───

    function importSelected() {
        var selectedPaths = files.filter(function (f) { return f.selected; }).map(function (f) { return f.path; });
        if (selectedPaths.length === 0) return;

        doImport(selectedPaths);

        // Mark as imported
        files.forEach(function (f) {
            if (f.selected) {
                f.imported = true;
                f.selected = false;
            }
        });
        renderGrid();
    }

    function doImport(pathsArray) {
        var jsonPaths = JSON.stringify(pathsArray);
        var escaped = escapeForScript(jsonPaths);

        if (chkCreateBin.checked) {
            var binName = escapeForScript(binNameInput.value || 'pxf Proxies');
            csInterface.evalScript(
                'createBinAndImport(\'' + escaped + '\', \'' + binName + '\')',
                function (result) {
                    if (result === 'ok') {
                        showToast('Imported ' + pathsArray.length + ' file' + (pathsArray.length > 1 ? 's' : ''));
                    } else {
                        showToast('Import error: ' + result);
                    }
                }
            );
        } else {
            csInterface.evalScript(
                'importFiles(\'' + escaped + '\')',
                function (result) {
                    if (result === 'ok') {
                        showToast('Imported ' + pathsArray.length + ' file' + (pathsArray.length > 1 ? 's' : ''));
                    } else {
                        showToast('Import error: ' + result);
                    }
                }
            );
        }
    }

    // ─── Utilities ───

    function escapeForScript(str) {
        return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    function formatDate(timestamp) {
        var d = new Date(timestamp);
        var now = new Date();
        var diff = now - d;

        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
        if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';

        return (d.getMonth() + 1) + '/' + d.getDate();
    }

    function showToast(message) {
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(function () {
            toast.classList.remove('show');
        }, 2500);
    }

    // ─── Start ───
    init();

})();
