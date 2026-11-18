import { TestBed } from '@angular/core/testing';
import { CutoutTool } from './cutout-tool';

describe('CutoutTool', () => {
  let service: CutoutTool;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(CutoutTool);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
