import { describe, expect, it } from 'vitest';
import {
  countChanged,
  describeDefault,
  filterProperties,
  groupProperties,
  humanizeName,
  isChangedFromDefault,
  sameValue,
  segmentable,
  SLIDER_STEPS,
  sliderScale,
} from './properties';
import type { PropertyNode } from './types';

function prop(partial: Partial<PropertyNode> & { name: string }): PropertyNode {
  return {
    path: [partial.name],
    description: '',
    valueType: 'float',
    itemType: 'undefined',
    keyType: 'undefined',
    readOnly: false,
    visible: true,
    isReferenced: false,
    unit: null,
    minValue: null,
    maxValue: null,
    defaultValue: null,
    suggestedValues: null,
    selectionValues: null,
    hasCoercer: false,
    hasValidator: false,
    callable: null,
    structTypeName: null,
    value: null,
    displayValue: null,
    selectionKey: null,
    children: null,
    error: null,
    ...partial,
  } as PropertyNode;
}

// Shapes as the reference device's RefCh0 reports them (checked against the API).
const waveform = prop({
  name: 'Waveform',
  valueType: 'int',
  value: 'Sine',
  displayValue: 'Sine',
  defaultValue: 0,
  selectionKey: 0,
  selectionValues: ['Sine', 'Rect', 'None', 'Counter', 'Constant'].map((label, key) => ({ key, label })),
});
const frequency = prop({ name: 'Frequency', value: 10, defaultValue: 10, minValue: 0.1, maxValue: 10000 });

describe('isChangedFromDefault', () => {
  it('compares a selection by its key, not its label', () => {
    // value is the label "Sine" and the default the key 0: that is *not* a change.
    expect(isChangedFromDefault(waveform)).toBe(false);
    expect(isChangedFromDefault({ ...waveform, value: 'Rect', selectionKey: 1 })).toBe(true);
  });

  it('notices a changed number, and ignores float noise', () => {
    expect(isChangedFromDefault(frequency)).toBe(false);
    expect(isChangedFromDefault({ ...frequency, value: 37 })).toBe(true);
    expect(isChangedFromDefault({ ...frequency, value: 0.1 + 0.2, defaultValue: 0.3 })).toBe(false);
  });

  it('never marks a read-only value, which the device set and nobody can reset', () => {
    expect(isChangedFromDefault(prop({ name: 'TestReadOnly', valueType: 'bool', readOnly: true, value: true, defaultValue: false }))).toBe(false);
  });

  it('compares structs by their fields and enumerations by name', () => {
    const range = (low: number) => ({ kind: 'struct', typeName: 'Range', fieldNames: ['LowValue'], fields: { LowValue: low } });
    expect(isChangedFromDefault(prop({ name: 'CustomRange', valueType: 'struct', value: range(-10), defaultValue: range(-10) }))).toBe(false);
    expect(isChangedFromDefault(prop({ name: 'CustomRange', valueType: 'struct', value: range(-5), defaultValue: range(-10) }))).toBe(true);
    const enumeration = (name: string) => ({ kind: 'enumeration', typeName: 'Mode', name, value: null, enumerators: ['A', 'B'] });
    expect(isChangedFromDefault(prop({ name: 'Mode', valueType: 'enumeration', value: enumeration('B'), defaultValue: enumeration('A') }))).toBe(true);
  });

  it('has nothing to say about objects, callables, or a property with no default', () => {
    expect(isChangedFromDefault(prop({ name: 'Protected', valueType: 'object', value: { kind: 'object' }, defaultValue: { kind: 'object', className: 'x' } }))).toBe(false);
    expect(isChangedFromDefault(prop({ name: 'Sum', valueType: 'func' }))).toBe(false);
    expect(isChangedFromDefault(prop({ name: 'Free', value: 3, defaultValue: null }))).toBe(false);
  });
});

describe('describeDefault', () => {
  it('names a selection default by its label', () => {
    expect(describeDefault(waveform)).toBe('Sine');
    expect(describeDefault(frequency)).toBe('10');
  });
});

describe('sameValue', () => {
  it('treats arrays and records structurally', () => {
    expect(sameValue([1, 2], [1, 2])).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe('segmentable', () => {
  it('offers buttons for a short set of short options', () => {
    expect(segmentable(waveform)).toBe(true);
  });

  it('keeps a dropdown when the options would not fit on a line', () => {
    const many = { ...waveform, selectionValues: Array.from({ length: 8 }, (_, key) => ({ key, label: `Option ${key}` })) };
    expect(segmentable(many)).toBe(false);
    const wordy = { ...waveform, selectionValues: [{ key: 0, label: 'A rather long option label' }, { key: 1, label: 'B' }] };
    expect(segmentable(wordy)).toBe(false);
    expect(segmentable(frequency)).toBe(false);
  });
});

describe('sliderScale', () => {
  it('is logarithmic across decades, so every decade gets the same travel', () => {
    const scale = sliderScale(frequency)!;
    expect(scale.kind).toBe('log');
    // 0.1 … 10 000 is five decades; 10 Hz sits exactly two fifths along.
    expect(scale.toPosition(10)).toBe(0.4 * SLIDER_STEPS);
    expect(scale.toValue(scale.toPosition(1000))).toBe(1000);
    expect(scale.toValue(0)).toBe(0.1);
    expect(scale.toValue(SLIDER_STEPS)).toBe(10000);
  });

  it('is linear over a narrow range, and snaps integers', () => {
    const scale = sliderScale(prop({ name: 'AcquisitionLoopTime', valueType: 'int', minValue: 10, maxValue: 1000, value: 20 }))!;
    expect(scale.kind).toBe('log');
    const amplitude = sliderScale(prop({ name: 'Amplitude', minValue: 0, maxValue: 10, value: 5 }))!;
    expect(amplitude.kind).toBe('linear');
    expect(amplitude.toPosition(5)).toBe(SLIDER_STEPS / 2);
    const channels = sliderScale(prop({ name: 'Channels', valueType: 'int', minValue: 1, maxValue: 8, value: 2 }))!;
    expect(Number.isInteger(channels.toValue(333))).toBe(true);
  });

  it('offers no slider without both limits, or on a read-only value', () => {
    expect(sliderScale(prop({ name: 'Offset', valueType: 'int', minValue: 0, maxValue: null }))).toBeNull();
    expect(sliderScale({ ...frequency, readOnly: true })).toBeNull();
    expect(sliderScale(prop({ name: 'Name', valueType: 'string', minValue: 0, maxValue: 1 }))).toBeNull();
  });
});

describe('grouping and filtering', () => {
  const owner = prop({ name: 'Owner', valueType: 'string', value: 'me', defaultValue: 'openDAQ TM', displayValue: 'me' });
  const sum = prop({ name: 'Sum', valueType: 'func' });
  const protectedGroup = prop({ name: 'Protected', valueType: 'object', children: [owner, sum] });
  const tree = [frequency, waveform, protectedGroup];

  it('puts plain properties in General and gives each object its own section', () => {
    const { general, sections } = groupProperties(tree);
    expect(general.map((node) => node.name)).toEqual(['Frequency', 'Waveform']);
    expect(sections.map((node) => node.name)).toEqual(['Protected']);
  });

  it('finds a property inside its section, carrying only what matched', () => {
    const result = filterProperties(tree, 'owner', false);
    expect(result.map((node) => node.name)).toEqual(['Protected']);
    expect(result[0]?.children?.map((node) => node.name)).toEqual(['Owner']);
  });

  it('keeps a whole section when the search names the section', () => {
    expect(filterProperties(tree, 'protected', false)[0]?.children).toHaveLength(2);
  });

  it('shows only what has been changed, wherever it is', () => {
    const result = filterProperties(tree, '', true);
    expect(result.map((node) => node.name)).toEqual(['Protected']);
    expect(result[0]?.children?.map((node) => node.name)).toEqual(['Owner']);
    expect(countChanged(tree)).toBe(1);
  });
});

describe('humanizeName', () => {
  it('reads the reference device the way a person would', () => {
    expect(humanizeName('NumberOfChannels')).toBe('Number of channels');
    expect(humanizeName('GlobalSampleRate')).toBe('Global sample rate');
    expect(humanizeName('userName')).toBe('User name');
  });

  it('keeps acronyms and digits intact', () => {
    expect(humanizeName('EnableCANChannel')).toBe('Enable CAN channel');
    expect(humanizeName('DC')).toBe('DC');
    expect(humanizeName('Custom2dMinRange')).toBe('Custom 2d min range');
    expect(humanizeName('PTPMode')).toBe('PTP mode');
  });

  it('leaves a name that is already words alone', () => {
    expect(humanizeName('Owner')).toBe('Owner');
    expect(humanizeName('sample_rate')).toBe('Sample rate');
  });
});
