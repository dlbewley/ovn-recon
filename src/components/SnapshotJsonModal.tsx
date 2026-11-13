import * as React from 'react';
import { Button, Modal, ModalBody, ModalFooter, ModalHeader, ModalVariant } from '@patternfly/react-core';
import { CodeEditor, Language } from '@patternfly/react-code-editor';

import { downloadJson } from './downloadJson';
import { useIsDarkTheme } from './useIsDarkTheme';

export interface SnapshotJsonProps {
    /** What the payload is, e.g. "cnv-1 snapshot" — names the modal and file. */
    label: string;
    filename: string;
    payload: unknown;
}

/**
 * The raw collector JSON in a modal, with a download (ovn-recon-jxh): the payload is
 * already in memory from the page's own fetch, so both actions are purely
 * client-side. The view toolbar opens it from its overflow menu (ovn-recon-nt4.3).
 */
export const SnapshotJsonModal: React.FC<SnapshotJsonProps & { isOpen: boolean; onClose: () => void }> = ({
    label,
    filename,
    payload,
    isOpen,
    onClose,
}) => {
    const isDarkTheme = useIsDarkTheme();
    return (
        <Modal variant={ModalVariant.large} isOpen={isOpen} onClose={onClose} aria-label={label}>
            <ModalHeader title={label} />
            <ModalBody>
                {isOpen && (
                    <CodeEditor
                        isDarkTheme={isDarkTheme}
                        isReadOnly
                        code={JSON.stringify(payload, null, 2)}
                        language={Language.json}
                        height="60vh"
                    />
                )}
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={() => downloadJson(filename, payload)}>
                    Download {filename}
                </Button>
                <Button variant="link" onClick={onClose}>
                    Close
                </Button>
            </ModalFooter>
        </Modal>
    );
};
