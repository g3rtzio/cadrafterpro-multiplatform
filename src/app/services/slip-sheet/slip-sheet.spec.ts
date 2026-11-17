import { TestBed } from '@angular/core/testing';
import { SlipSheet } from './slip-sheet';

describe('SlipSheet', () => {
  let service: SlipSheet;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(SlipSheet);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
