import { ImageManipulator } from 'expo-image-manipulator';

import { prepareProof } from '@/lib/proof-image';

// jest.mock is hoisted above the imports.
const mockResize = jest.fn();
const mockSave = jest.fn(async () => ({ uri: 'file:///cache/resized.jpg', width: 1080, height: 1440 }));
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
  ImageManipulator: {
    manipulate: jest.fn(() => ({
      resize: mockResize,
      renderAsync: async () => ({ saveAsync: mockSave }),
    })),
  },
}));

it('resizes captures to 1080 px wide JPEG at quality 0.7', async () => {
  expect(await prepareProof('file:///cache/raw.jpg')).toBe('file:///cache/resized.jpg');
  expect(ImageManipulator.manipulate).toHaveBeenCalledWith('file:///cache/raw.jpg');
  expect(mockResize).toHaveBeenCalledWith({ width: 1080 });
  expect(mockSave).toHaveBeenCalledWith({ compress: 0.7, format: 'jpeg' });
});
