/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 *
 * SuiteScript Version Tracker - file reader RESTlet.
 * Deploy once per NetSuite account. Read-only: returns the content of a
 * JavaScript file from the File Cabinet so the tracker can compare it with
 * the last saved version.
 *
 * Call:  GET <restlet url>&fileId=<File Cabinet internal id>
 * Reply: { id, name, content, lastModified }
 */
define(['N/file', 'N/log'], (file, log) => {
    const MAX_BYTES = 2 * 1024 * 1024;

    const get = (params) => {
        try {
            const id = params && params.fileId;
            if (!id || !/^\d+$/.test(String(id))) {
                return { error: 'fileId (number) is required' };
            }
            const f = file.load({ id: String(id) });

            // Only JavaScript files, nothing else in the File Cabinet is exposed
            if (f.fileType !== file.Type.JAVASCRIPT) {
                return { error: 'Only JavaScript files can be read' };
            }
            if (f.size > MAX_BYTES) {
                return { error: 'File is larger than 2 MB' };
            }
            return {
                id: f.id,
                name: f.name,
                content: f.getContents(),
                lastModified: f.lastModified ? String(f.lastModified) : null
            };
        } catch (e) {
            log.error({ title: 'ns_file_reader', details: e });
            return { error: e.name || 'ERROR' };
        }
    };

    return { get };
});
