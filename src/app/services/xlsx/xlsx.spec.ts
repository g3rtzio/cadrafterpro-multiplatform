import { TestBed } from '@angular/core/testing';
import { Xlsx } from './xlsx';

describe('Xlsx', () => {
  let service: Xlsx;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Xlsx);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
