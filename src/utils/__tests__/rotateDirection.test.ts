import { describe, it, expect } from 'vitest';
import { rotateBytes } from '../khDecrypt';

describe('rotateBytes direction vs C# RotateRight', () => {
  it('C# RotateRight(data, 0, 5, 2) 应把最后2字节移到前面', () => {
    // C# RotateRight: array = [0,1,2,3,4], num2=2
    // BlockCopy(array, 5-2=3, data, 0, 2) → data[0:2] = [3,4]
    // BlockCopy(array, 0, data, 2, 3)     → data[2:5] = [0,1,2]
    // 结果: [3,4,0,1,2]
    const data = new Uint8Array([0, 1, 2, 3, 4]);
    const result = rotateBytes(data, 0, 5, 2);
    expect(Array.from(result)).toEqual([3, 4, 0, 1, 2]);
  });

  it('C# RotateRight(data, 0, 6, 3)', () => {
    // array = [0,1,2,3,4,5], num2=3
    // data[0:3] = [3,4,5], data[3:6] = [0,1,2]
    // 结果: [3,4,5,0,1,2]
    const data = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const result = rotateBytes(data, 0, 6, 3);
    expect(Array.from(result)).toEqual([3, 4, 5, 0, 1, 2]);
  });

  it('C# RotateRight with start offset', () => {
    // data = [0,1,2,3,4,5,6], start=2, length=4, step=1
    // 子数组 = [2,3,4,5], num2=1
    // data[2:3] = [5], data[3:6] = [2,3,4]
    // 结果: [0,1,5,2,3,4,6]
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6]);
    const result = rotateBytes(data, 2, 4, 1);
    expect(Array.from(result)).toEqual([0, 1, 5, 2, 3, 4, 6]);
  });
});
