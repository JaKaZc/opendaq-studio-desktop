import { useDialogs } from '../../store/useDialogs';
import { ConfirmDialog } from '../ui/Modal';
import { AddDeviceDialog } from './AddDeviceDialog';
import { AddFunctionBlockDialog, AddServerDialog, LoadModuleDialog } from './AddComponentDialogs';
import { AttributesDialog, DescriptorDialog, DeviceInfoDialog, StatusesDialog } from './ComponentDialogs';
import { LoadConfigurationDialog, SaveConfigurationDialog } from './LoadConfigurationDialog';
import {
  ContainerEditorDialog,
  ExecutePropertyDialog,
  PropertyMetadataDialog,
  ViewValueDialog,
} from './PropertyDialogs';
import { AboutDialog, MetadataColumnsDialog, ShortcutsDialog } from './SettingsDialogs';

/**
 * Renders whichever dialog is open.
 *
 * One switch instead of a dozen mount points: dialogs are mutually exclusive here,
 * so this keeps the tree shallow and makes it obvious what can be open at all.
 */
export function DialogHost() {
  const dialog = useDialogs((state) => state.dialog);
  const confirm = useDialogs((state) => state.confirm);
  const confirmBusy = useDialogs((state) => state.confirmBusy);
  const resolveConfirm = useDialogs((state) => state.resolveConfirm);
  const cancelConfirm = useDialogs((state) => state.cancelConfirm);

  return (
    <>
      {renderDialog(dialog)}

      {confirm ? (
        <ConfirmDialog
          open
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          destructive={confirm.destructive ?? true}
          busy={confirmBusy}
          onClose={cancelConfirm}
          onConfirm={() => void resolveConfirm()}
        />
      ) : null}
    </>
  );
}

function renderDialog(dialog: ReturnType<typeof useDialogs.getState>['dialog']) {
  switch (dialog.kind) {
    case 'addDevice':
      return <AddDeviceDialog parentId={dialog.parentId} initialConnectionString={dialog.connectionString} />;
    case 'addFunctionBlock':
      return <AddFunctionBlockDialog parentId={dialog.parentId} />;
    case 'addServer':
      return <AddServerDialog />;
    case 'loadConfiguration':
      return <LoadConfigurationDialog />;
    case 'saveConfiguration':
      return <SaveConfigurationDialog />;
    case 'loadModule':
      return <LoadModuleDialog />;
    case 'attributes':
      return <AttributesDialog componentId={dialog.componentId} />;
    case 'statuses':
      return <StatusesDialog componentId={dialog.componentId} />;
    case 'descriptor':
      return <DescriptorDialog signalId={dialog.signalId} />;
    case 'deviceInfo':
      return <DeviceInfoDialog connectionString={dialog.connectionString} parentId={dialog.parentId} />;
    case 'propertyMetadata':
      return <PropertyMetadataDialog componentId={dialog.componentId} path={dialog.path} />;
    case 'executeProperty':
      return <ExecutePropertyDialog componentId={dialog.componentId} path={dialog.path} />;
    case 'editContainer':
      return <ContainerEditorDialog componentId={dialog.componentId} path={dialog.path} />;
    case 'viewValue':
      return <ViewValueDialog title={dialog.title} text={dialog.text} />;
    case 'metadataColumns':
      return <MetadataColumnsDialog />;
    case 'shortcuts':
      return <ShortcutsDialog />;
    case 'about':
      return <AboutDialog />;
    case 'none':
      return null;
  }
}
