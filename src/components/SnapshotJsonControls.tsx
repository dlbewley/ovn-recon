import * as React from 'react';
import { Button, Modal, ModalBody, ModalFooter, ModalHeader, ModalVariant } from '@patternfly/react-core';
import { CodeEditor, Language } from '@patternfly/react-code-editor';

import { downloadJson } from './downloadJson';
import { useIsDarkTheme } from './useIsDarkTheme';

export interface SnapshotJsonControlsProps {
    /** What the payload is, e.g. "cnv-1 snapshot" — names the modal and file. */
    label: string;
    filename: string;
    payload: unknown;
}

/**
 * View + download of the raw collector JSON (ovn-recon-jxh): the payload is
 * already in memory from the page's own fetch, so both actions are purely
 * client-side.
 */
const SnapshotJsonControls: React.FC<SnapshotJsonControlsProps> = ({ label, filename, payload }) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const isDarkTheme = useIsDarkTheme();

    return (
        <>
            <Button variant="link" isInline onClick={() => setIsOpen(true)}>
                View JSON
            </Button>
            <Modal
                variant={ModalVariant.large}
                isOpen={isOpen}
                onClose={() => setIsOpen(false)}
                aria-label={label}
            >
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
                    <Button variant="link" onClick={() => setIsOpen(false)}>
                        Close
                    </Button>
                </ModalFooter>
            </Modal>
        </>
    );
};

export default SnapshotJsonControls;
