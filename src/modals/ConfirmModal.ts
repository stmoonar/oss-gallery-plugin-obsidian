import { App, Modal, Setting } from "obsidian";
import { t } from '../i18n';

export interface ConfirmModalOptions {
    title?: string;
    message?: string;
    /** Names listed under the message (e.g. the first files of a batch). */
    names?: string[];
    /** How many more items are not listed. */
    more?: number;
    confirmText?: string;
}

export class ConfirmModal extends Modal {
    private onConfirm: () => void;

    constructor(app: App, onConfirm: () => void, private readonly options: ConfirmModalOptions = {}) {
        super(app);
        this.onConfirm = onConfirm;
        this.containerEl.addClass('oss-gallery-confirm-modal');
    }

    onOpen() {
        const {contentEl} = this;
        const o = this.options;
        contentEl.empty();

        this.setTitle(o.title ?? t('Delete'));

        contentEl.createEl("p", {
            text: o.message ?? t('Confirm delete?'),
            cls: 'oss-gallery-confirm-message'
        });

        if (o.names && o.names.length > 0) {
            const list = contentEl.createEl('ul', { cls: 'oss-gallery-confirm-names' });
            for (const name of o.names) {
                list.createEl('li', { text: name });
            }
            if (o.more && o.more > 0) {
                list.createEl('li', {
                    cls: 'oss-gallery-confirm-more',
                    text: t('And more').replace('{count}', String(o.more)),
                });
            }
        }

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('Cancel'))
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText(o.confirmText ?? t('Delete'))
                .setWarning()
                .onClick(() => {
                    this.onConfirm();
                    this.close();
                }));
    }

    onClose() {
        const {contentEl} = this;
        contentEl.empty();
    }
}
