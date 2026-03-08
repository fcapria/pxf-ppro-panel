/**
 * pxf Proxy Importer - ExtendScript for Premiere Pro
 * Handles importing files and bin management.
 */

/**
 * Import files into the current Premiere Pro project.
 * @param {string} jsonPaths - JSON-encoded array of file paths
 * @returns {string} "ok" on success, error message on failure
 */
function importFiles(jsonPaths) {
    try {
        var paths = JSON.parse(jsonPaths);
        if (!paths || paths.length === 0) {
            return "error: no files specified";
        }
        var success = app.project.importFiles(paths, true);
        return success ? "ok" : "error: import failed";
    } catch (e) {
        return "error: " + e.message;
    }
}

/**
 * Import files into a specific bin (created if it doesn't exist).
 * @param {string} jsonPaths - JSON-encoded array of file paths
 * @param {string} binName - Name of the target bin
 * @returns {string} "ok" on success, error message on failure
 */
function createBinAndImport(jsonPaths, binName) {
    try {
        var paths = JSON.parse(jsonPaths);
        if (!paths || paths.length === 0) {
            return "error: no files specified";
        }

        var rootItem = app.project.rootItem;
        var targetBin = null;

        // Look for existing bin
        for (var i = 0; i < rootItem.children.numItems; i++) {
            var child = rootItem.children[i];
            if (child.name === binName && child.type === ProjectItemType.BIN) {
                targetBin = child;
                break;
            }
        }

        // Create bin if it doesn't exist
        if (!targetBin) {
            rootItem.createBin(binName);
            for (var i = 0; i < rootItem.children.numItems; i++) {
                var child = rootItem.children[i];
                if (child.name === binName && child.type === ProjectItemType.BIN) {
                    targetBin = child;
                    break;
                }
            }
        }

        if (targetBin) {
            app.project.importFiles(paths, true, targetBin, false);
        } else {
            app.project.importFiles(paths, true);
        }

        return "ok";
    } catch (e) {
        return "error: " + e.message;
    }
}

/**
 * Open a folder selection dialog and return the chosen path.
 * @returns {string} The selected folder path, or empty string if cancelled
 */
function selectFolder(startPath) {
    var folder;
    if (startPath && startPath !== "") {
        folder = new Folder(startPath);
    } else {
        folder = Folder.desktop;
    }
    var selected = folder.selectDlg("Select proxy output folder");
    if (selected) {
        return selected.fsName;
    }
    return "";
}
